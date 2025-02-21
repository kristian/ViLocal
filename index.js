#!/usr/bin/env node
process.env.ZBTK_FORMAT_EUI_SEPARATOR = '-'; // like Viessmann uses it for their devices

import fs from 'fs/promises';
import { Buffer } from 'node:buffer';
async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    } else {
      throw err;
    }
  }
}
import { parse as parseToml } from 'smol-toml';

import { connectAsync as mqttConnect } from 'mqtt';
import { open as openCap } from 'zbtk/cap';
import { pk } from 'zbtk/crypto';
import { fromHex } from 'zbtk/utils';
import { eui as formatEui } from 'zbtk/format';
import packageJson from './package.json' with { type: 'json' };

const TYPE_THERMOSTAT = 'thermostat', TYPE_CLIMATE_SENSOR = 'climate_sensor';

const configFile = (await exists('local_config.toml')) ? 'local_config.toml' : 'config.toml';
const config = parseToml(await fs.readFile(configFile, 'utf8'));

async function iterateDevices(callback) {
  for (const [type, devices] of Object.entries({
    [TYPE_THERMOSTAT]: config.thermostats ?? {},
    [TYPE_CLIMATE_SENSOR]: config.climate_sensors ?? {}
  })) {
    for (const [id, options] of Object.entries(devices)) {
      await callback(type, id, options);
    }
  }
}

// validate / check configuration for basic consistency
if (!config.device) {
  throw new TypeError(`No capture "device" configured in "${ configFile }"`);
}
if (!config.network_key && !process.env.ZBTK_CRYPTO_PKS) {
  console.warn(`Neither a "network_key" is configured in "${ configFile }", nor the "ZBTK_CRYPTO_PKS" environment variable is set. Without a network key, packets will not get decrypted, which will likely cause that no attributes are being reported. Please capture a transport key / configure a network key to enable proper functionality.`)
}
if (!config.mqtt || !config.mqtt.url) {
  throw new TypeError(`No MQTT (URL) configuration provided in "${ configFile }"`);
}
config.mqtt.online ??= true; // if not set, use a online topic

const configDevices = new Set();
iterateDevices((type, id, options) => {
  if (!options?.serial_no) {
    throw new TypeError(`Missing "serial_no" of ${type.replace('_', ' ')} "${id}" in "${ configFile }"`);
  }

  const hexEui = fromHex(options.serial_no).toString('hex');
  if (configDevices.has(hexEui)) {
    throw new TypeError(`Duplicate serial number "${formatEui(options.serial_no)}" found for ${type.replace('_', ' ')} "${id}" in "${ configFile }"`);
  } else {
    configDevices.add(hexEui);
  }
});

const mqttTopic = config.mqtt.topic ?? 'ViLocal', mqttAvailabilityTopic =
  `${mqttTopic}/${typeof config.mqtt.online === 'string' ? config.mqtt.online : 'online'}`;

const mqttOptions = {
  username: config.mqtt.username,
  password: config.mqtt.password,
  ...(config.mqtt.options || {}),
  ...(config.mqtt.online ? {
    will: { // last will to set ViLocal offline
      topic: mqttAvailabilityTopic,
      payload: `${false}`,
      retain: true
    }
  } : {})
};

// connect to MQTT broker
const mqttClient = await mqttConnect(config.mqtt.url, mqttOptions);
const mqttConnected = async () => {
  config.mqtt.online && await mqttClient.publishAsync(
    mqttAvailabilityTopic, `${true}`, { retain: true });
};
await mqttConnected(); // set ViLocal online
mqttClient.on('connect', mqttConnected);

const knownDevices = new Set();
/**
 * Publish a device to Home Assistant's MQTT discovery service.
 *
 * @param {Buffer} eui the EUI-64 of the device derived from the options.serial_no
 * @param {string} type either "thermostat" or "climate_sensor"
 * @param {string} [id] the ID of the device
 * @param {object} [options] config. options for the device
 * @param {string} [options.name] the name of the device
 * @param {Buffer} [options.climate_sensor_serial_no] the EUI-64 of the climate sensor associated with the thermostat, only for type "thermostat"
 */
async function publishDevice(eui, type, id, options) {
  if (!type) {
    throw new TypeError('Type of device must be provided');
  }
  if (!id) {
    id = type; // e.g. "thermostat", or user specified "thermostat_bedroom"
  }

  const hexEui = eui.toString('hex');
  const formattedEui = formatEui(eui);
  const deviceTopic = `${mqttTopic}/${formattedEui}`;
  const genericName = type === TYPE_THERMOSTAT ? 'Thermostat' : 'Climate Sensor';
  const name = options?.name ?? genericName;

  // add device to the known devices list
  knownDevices.add(hexEui);

  function discoveryComponent(suffix, platform, options) {
    if (!options) {
      options = platform;
      platform = suffix;
      suffix = '';
    }

    if (suffix && !suffix.startsWith('_')) {
      suffix = `_${suffix}`;
    }
    const unique_id = `vilocal_${hexEui}${suffix}`;

    return {
      [unique_id]: {
        platform,

        object_id: `vilocal_${type}_${id}${suffix}`,
        name: options?.name, // will automatically get prefixed with the device name
        unique_id,

        ...options
      }
    };
  }
  // build the discovery record
  const discovery = {
    device: {
      name,
      identifiers: formattedEui,
      serial_number: formattedEui,
      manufacturer: 'Viessmann',
      model: `ViCare ${genericName}`,
      model_id: type === TYPE_THERMOSTAT ? 'ZK03840' : 'ZK05991'
    },
    origin: { // see https://www.home-assistant.io/integrations/mqtt/#adding-information-about-the-origin-of-a-discovery-message
      name: 'ViLocal',
      sw_version: packageJson.version,
      support_url: 'https://github.com/kristian/ViLocal/issues'
    },
    ...(config.mqtt.online ? {
      availability: [ // see https://www.home-assistant.io/integrations/mqtt/#using-availability-topics
        {
          topic: mqttAvailabilityTopic,
          payload_available: 'true',
          payload_not_available: 'false',
        }
      ]
    } : {}),
    // depending of the type of device, different components will be announced:
    // - thermostats expose as a climate component
    // - climate sensors expose as a temperature and humidity sensor
    // all devices also expose a sensor showing the battery level, as well as the current link quality
    components: {
      ...(type === TYPE_THERMOSTAT ? {
        // each component requires a id for discovery (the name of the attribute in the components object)
        // as well as a object_id that is used for deriving the entity_id in home assistant, a unique_id
        // in order to be able to change the entity_id and a display name, see https://www.home-assistant.io/integrations/mqtt/#naming-of-mqtt-entities
        ...discoveryComponent('climate', {
          name: null, // use the name of the device

          modes: ['auto'],
          swing_modes: [],
          fan_modes: [],
          temp_step: 0.5,
          optimistic: false,
          precision: 0.1,

          // use an arbitrary existing topic (the availability topic is always retained) to disable optimistic mode ...
          mode_state_topic: config.mqtt.online ? mqttAvailabilityTopic : '$SYS/broker/version',
          mode_state_template: 'auto', // ... as state of thermostats is always auto (they will turn on if needed)

          temperature_state_topic: `${deviceTopic}/0x0201/0x0012`, // Thermostat / Occupied Heating Setpoint
          temperature_state_template: '{{ (value | float ) / 100 | round(2) }}',
          ...(!options?.climate_sensor_serial_no ? { // thermostats can be associated to a climate sensor for example in the same room
            current_temperature_topic: `${deviceTopic}/0x0201/0x0000`, // Thermostat / Local Temperature
            current_temperature_template: '{{ (value | float ) / 100 | round(2) }}',
          } : { // in case of an associated climate sensor, display its temperature / humidity values instead of the ones reported by the thermostat
            current_temperature_topic: `${mqttTopic}/${formatEui(options.climate_sensor_serial_no)}/0x0402/0x0000`,
            current_temperature_template: '{{ (value | float ) / 100 | round(2) }}',
            current_humidity_topic: `${mqttTopic}/${formatEui(options.climate_sensor_serial_no)}/0x0405/0x0000`,
            current_humidity_template: '{{ (value | float ) / 100 | round(2) }}',
          })
        }),
        // also expose the individual values as sensors
        ...discoveryComponent('heating_setpoint', 'sensor', {
          name: 'Heating Setpoint', // will automatically get prefixed with the device name
    
          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0201/0x0012`, // Thermostat / Occupied Heating Setpoint
          value_template: '{{ (value | float ) / 100 | round(2) }}'
        }),
        ...discoveryComponent('temperature', 'sensor', {
          name: 'Temperature', // will automatically get prefixed with the device name
    
          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0201/0x0000`, // Thermostat / Local Temperature
          value_template: '{{ (value | float ) / 100 | round(2) }}'
        }),
        ...discoveryComponent('window_open', 'binary_sensor', {
          name: 'Window Open', // will automatically get prefixed with the device name
    
          device_class: 'window',
          state_topic: `${deviceTopic}/0x0201/0x4000`, // Thermostat / Manufacturer Specific (OpenWindowDetection)
          value_template: '{{ "ON" if (value | int) == 3 else "OFF" }}'
        })
      } : { // Climate Sensor
        ...discoveryComponent('temperature', 'sensor', {
          name: 'Temperature', // will automatically get prefixed with the device name
    
          device_class: 'temperature',
          unit_of_measurement: '°C',
          suggested_display_precision: 1,
          state_topic: `${deviceTopic}/0x0402/0x0000`, // Temperature Measurement / Value
          value_template: '{{ (value | float ) / 100 | round(2) }}'
        }),
        ...discoveryComponent('humidity', 'sensor', {
          name: 'Humidity', // will automatically get prefixed with the device name

          device_class: 'humidity',
          unit_of_measurement: '%',
          suggested_display_precision: 0,
          state_topic: `${deviceTopic}/0x0405/0x0000`, // Relative Humidity / Measurement Value
          value_template: '{{ (value | float ) / 100 | round(2) }}'
        })
      }),
      ...discoveryComponent('battery_level', 'sensor', {
        name: 'Battery Level', // will automatically get prefixed with the device name

        device_class: 'battery',
        unit_of_measurement: '%',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0001/0x0021`, // Power Configuration / Battery Percentage Remaining
        value_template: '{{ (value | float ) / 2 }}'
      }),
      ...discoveryComponent('link_quality', 'sensor', {
        name: 'Link Quality', // will automatically get prefixed with the device name

        icon: 'mdi:signal',
        unit_of_measurement: '%',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0B05/0x011C`, // Diagnostics / Last LQI
        value_template: '{{ ((value | float) / 255) * 100 | round(1) }}'
      }),
      ...discoveryComponent('signal_strength', 'sensor', {
        name: 'Signal Strength', // will automatically get prefixed with the device name

        device_class: 'signal_strength',
        unit_of_measurement: 'dBm',
        suggested_display_precision: 0,
        state_topic: `${deviceTopic}/0x0B05/0x011D`, // Diagnostics / Last RSSI
        value_template: '{{ value | int }}'
      })
    }
  };

  // publish to device discovery topic, see: https://www.home-assistant.io/integrations/mqtt/#discovery-messages
  // config messages are retained, see: https://www.home-assistant.io/integrations/mqtt/#using-retained-config-messages
  await mqttClient.publishAsync(`${config.device_discovery_prefix ?? 'homeassistant'}/device/vilocal_${formattedEui.replaceAll(':', '-')}/config`,
    JSON.stringify(discovery), { retain: true });
}

// register devices
await iterateDevices(async (type, id, options) => {
  await publishDevice(fromHex(options.serial_no), type, id, options);
});

// set the pre-configured network key
config.network_key && pk(config.network_key);

// start capture session
const capSession = await openCap(config.device, {
  bufferSize: config.buffer_size ?? 10485760,
  emit: ['attribute'],
  out: {
    log: [config.log_level ?? 'warn'].flat(),
    mqtt: {
      client: mqttClient,
      topic: mqttTopic
    }
  }
});

capSession.on('attribute', async function(attr, context) {
  const { eui, cluster } = context;

  let type;
  switch (cluster.readUInt16BE(0)) {
    case 0x0201: // Thermostat
      type = TYPE_THERMOSTAT;
      break;
    case 0x0402: case 0x0405: // Temperature Measurement / Relative Humidity
      type = TYPE_CLIMATE_SENSOR;
      break;
    default:
      return; // ignore any other clusters, such as Diagnostics, etc.
  }

  if (!knownDevices.has(eui.toString('hex'))) {
    console.warn(`Received attributes from unknown ${type.replace('_', ' ')} with serial number "${formatEui(eui)}". Consider adding it to the "${ configFile }" file to provide a better device discovery record. Device will ${ (config.publish_unknown_devices ?? true) ? 'be published using generic information' : 'not be published, as "publish_unknown_devices" is set to "false"' }.`);
    if (config.publish_unknown_devices ?? true) {
      await publishDevice(eui, type);
    } else {
      // add it to the known-device list anyways / without publishing it to
      // device discovery, in order to not repeat log outputs for this device
      knownDevices.add(eui.toString('hex'));
    }
  }
});
