/*
 * ViCare valve calibration observations
 *
 * ViCare signals calibration with a special target position and can hold
 * it there before the sweep begins. A return to normal before the sweep
 * can signal cancellation and restore the previous range.
 *
 * During the sweep, targets advance in regular increments. The actual
 * position can lag, repeated targets can mark a pause, and passive capture
 * can miss updates. Timing helps distinguish missed steps from normal
 * valve movement. A resumed sweep clears a tentative departure, and a
 * second distinct departure confirms the transition back to normal.
 *
 * The sweep continued briefly after a noticeable temperature change, then
 * dropped to the closed position shown by ViCare. ViCare may be confirming
 * the temperature rise before backing off to close the valve securely.
 * The sensor, trigger, and backoff rule remain unverified.
 *
 * Normal valve movement provides enough actual and target readings to
 * learn the range over time. A calibration sweep helps find the closed
 * position sooner and provides an estimate of the full range.
 */

const VALVE_TRAVEL = 600; // nominal motor steps from fully closed to fully open.
const MIN_ESTIMATED_TRAVEL = 500; // show an estimate once observed travel exceeds this many steps.

const CALIBRATION_TARGET = 1; // target position that signals calibration.
const CALIBRATION_STEP = 5; // motor steps between sweep targets.
const CALIBRATION_STEP_INTERVAL = 60_000; // approximate milliseconds per sweep step for estimating missed updates.
const CALIBRATION_STEP_TOLERANCE = 1; // extra sweep steps allowed beyond the time-based estimate.

export const valvePositionTopics = {
  actual: '0x0201/0x4008',
  target: '0x0201/0x4009',
  attributes: 'valve_position/attributes'
};

const usableRangeTemplate = `low is integer and high is integer and ${MIN_ESTIMATED_TRAVEL} < high - low <= ${VALVE_TRAVEL}`;

export const valvePositionTemplates = {
  attributes: '{{ value or "{}" }}',
  availability: `
    {%- set low = value_json.low if value_json is mapping else none -%}
    {%- set high = value_json.high if value_json is mapping else none -%}
    {{- 'true' if ${usableRangeTemplate} else 'false' -}}
  `,
  value: `
    {%- set low = state_attr(entity_id, 'low') -%}
    {%- set high = state_attr(entity_id, 'high') -%}
    {%- set raw = value | int(none) -%}
    {{- ((raw - low) * 100 + ${VALVE_TRAVEL / 2}) // ${VALVE_TRAVEL}
        if ${usableRangeTemplate} and raw is integer and low <= raw <= high else none -}}
  `
};

const isMotorPosition = value => Number.isSafeInteger(value) && value >= 0;

function hasUsableRange(state) {
  const span = state?.high - state?.low;
  return span > MIN_ESTIMATED_TRAVEL && span <= VALVE_TRAVEL;
}

const attrsSuffix = `/${valvePositionTopics.attributes}`;
const retained = { retain: true, qos: 1 };

const isSweepTarget = value => (value - CALIBRATION_TARGET) % CALIBRATION_STEP === 0;

function followsSweep(reading, value, observedAt) {
  const steps = (value - reading.target) / CALIBRATION_STEP;
  const expectedSteps = Math.round((observedAt - reading.observedAt) / CALIBRATION_STEP_INTERVAL);
  const allowedSteps = Math.max(1, expectedSteps + CALIBRATION_STEP_TOLERANCE);
  return Number.isInteger(steps) && steps > 0 && steps <= allowedSteps;
}

function advanceCalibration(calibration, target, observedAt) {
  const { candidate } = calibration;
  if (target === calibration.target) {
    return candidate ? { ...calibration, candidate: undefined } : calibration;
  }
  if (target === candidate?.target) {
    return calibration;
  }

  const resumedAfterGap = candidate && candidate.target > calibration.target
    && isSweepTarget(candidate.target) && followsSweep(candidate, target, observedAt);
  if (followsSweep(calibration, target, observedAt) || resumedAfterGap) {
    return { target, observedAt };
  }

  // wait for a second distinct departure. A normal target before any sweep can cancel it immediately.
  if (!candidate && (calibration.target !== CALIBRATION_TARGET || isSweepTarget(target))) {
    return { ...calibration, candidate: { target, observedAt } };
  }
  return null;
}

export async function monitorValvePositions(mqttClient, mqttTopic, retainState = false) {
  const positions = new Map();
  const retainedRanges = new Map();
  const latestReadings = new Map();
  let pending = Promise.resolve();

  function enqueue(task) {
    const result = pending.then(task);
    pending = result.catch(() => {}); // keep later updates running if this one fails.
    return result;
  }

  function startCalibration(deviceTopic, observedAt, previousRange) {
    positions.set(deviceTopic, {
      calibration: { target: CALIBRATION_TARGET, observedAt, previousRange },
      restored: true
    });
  }

  function replay(topic) {
    return topic && mqttClient.publishAsync(topic, String(latestReadings.get(topic)), { retain: retainState });
  }

  async function replayPositions(state) {
    await Promise.all([replay(state.actual), replay(state.target)]);
  }

  async function persistRange(deviceTopic, { previous, force = false } = {}) {
    const state = positions.get(deviceTopic);
    const saved = retainedRanges.get(deviceTopic);
    const { low, high } = state;
    const changed = !saved || low !== saved.low || high !== saved.high;
    if (!changed && !force) {
      return;
    }

    const payload = low === undefined ? '' : JSON.stringify({ low, high });
    await mqttClient.publishAsync(`${deviceTopic}${attrsSuffix}`, payload, retained);
    retainedRanges.set(deviceTopic, state);

    // refresh both percentages after Home Assistant receives the new bounds.
    if (hasUsableRange(state) && (changed || retainState)) {
      await replayPositions(state);
    } else if (changed && hasUsableRange(saved)) {
      const lastUsable = state.calibration?.previousRange ?? (hasUsableRange(previous) ? previous : saved);
      await replayPositions(lastUsable);
    }
  }

  async function restoreRange(deviceTopic, payload) {
    const current = positions.get(deviceTopic);
    if (current?.restored) {
      return;
    }
    const { low, high, calibrating } = JSON.parse(payload.toString());
    if (calibrating === true) {
      // remove a retained calibration record from an earlier version.
      startCalibration(deviceTopic, Date.now());
      await persistRange(deviceTopic, { previous: current, force: true });
      return;
    }
    if (!isMotorPosition(low) || !isMotorPosition(high) || low > high) {
      return;
    }
    // a retained replay may arrive after SUBACK and an early live reading.
    let state = {
      ...current,
      low: Math.min(current?.low ?? low, low),
      high: Math.max(current?.high ?? high, high),
      restored: true
    };
    if (state.high - state.low > VALVE_TRAVEL) {
      // keep the new observations if a delayed replay would produce an oversized range.
      state = { ...current, restored: true };
    }
    retainedRanges.set(deviceTopic, { low, high });
    positions.set(deviceTopic, state);
    if (state.low !== low || state.high !== high) {
      await persistRange(deviceTopic, { previous: current });
    } else if (hasUsableRange(state)) {
      await replayPositions(state);
    }
  }

  mqttClient.on('message', (topic, payload, packet) => {
    if (packet.retain && topic.startsWith(`${mqttTopic}/`) && topic.endsWith(attrsSuffix)) {
      const deviceTopic = topic.slice(0, -attrsSuffix.length);
      enqueue(() => restoreRange(deviceTopic, payload))
        .catch(error => console.warn(`Could not restore valve range on ${topic}: ${error.message}`));
    }
  });
  await mqttClient.subscribeAsync(`${mqttTopic}/+${attrsSuffix}`, { qos: 1 })
    .catch(error => console.warn(`Could not subscribe to retained valve ranges: ${error.message}`));
  mqttClient.on('connect', () => {
    enqueue(async () => {
      for (const deviceTopic of positions.keys()) {
        // a restarted broker may have lost its retained messages.
        await persistRange(deviceTopic, { force: true })
          .catch(error => console.warn(`Could not republish valve range for ${deviceTopic}: ${error.message}`));
      }
    });
  });

  function observe(deviceTopic, position, value, topic, observedAt) {
    const previous = positions.get(deviceTopic);
    const calibration = previous?.calibration;
    if (position === 'target' && value === CALIBRATION_TARGET) {
      if (!calibration) {
        startCalibration(deviceTopic, observedAt, previous);
      } else if (calibration.target !== CALIBRATION_TARGET) {
        positions.set(deviceTopic, { ...previous, calibration: { target: value, observedAt } });
      }
      return;
    }
    if (position === 'actual' && calibration) {
      return;
    }
    if (calibration) {
      const nextCalibration = advanceCalibration(calibration, value, observedAt);
      if (nextCalibration) {
        if (nextCalibration !== calibration) {
          positions.set(deviceTopic, { ...previous, calibration: nextCalibration });
        }
        return;
      }
    }

    // the downward move after the sweep is the closed position.
    const lastProbe = calibration?.target;
    const candidateTarget = calibration?.candidate?.target;
    const closedPosition = lastProbe > CALIBRATION_TARGET && candidateTarget < lastProbe ? candidateTarget : undefined;
    // a return to normal before any sweep step means the previous range still applies.
    const range = calibration?.previousRange ?? previous;
    const lowerBound = closedPosition ?? range?.low ?? value;
    const upperBound = closedPosition === undefined ? range?.high ?? value : closedPosition + VALVE_TRAVEL;
    const low = Math.min(lowerBound, value);
    const high = Math.max(upperBound, value);
    const reset = high - low > VALVE_TRAVEL;
    const state = {
      ...(reset ? {} : range),
      [position]: topic,
      low: reset ? value : low,
      high: reset ? value : high,
      calibration: undefined,
      restored: reset || previous?.restored
    };
    positions.set(deviceTopic, state);
  }

  return {
    update(topic, value, observedAt = Date.now()) {
      const position = topic.endsWith(`/${valvePositionTopics.actual}`) ? 'actual'
        : topic.endsWith(`/${valvePositionTopics.target}`) ? 'target' : undefined;
      if (!position || !isMotorPosition(value)) {
        return;
      }
      const deviceTopic = topic.slice(0, -valvePositionTopics[position].length - 1);
      latestReadings.set(topic, value);
      return enqueue(async () => {
        const previous = positions.get(deviceTopic);
        observe(deviceTopic, position, value, topic, observedAt);
        await persistRange(deviceTopic, { previous });
      }).catch(error => console.warn(`Could not update valve range for ${deviceTopic}: ${error.message}`));
    },
    flush: () => pending
  };
}
