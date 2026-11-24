# Changelog

This file documents all *major & minor* releases. For revisions, please consult the [commit history](https://github.com/kristian/ViLocal/commits/main).

## [3.4] - 2026-11-24

- Add **Valve Position** and **Target Valve Position** diagnostics for ViCare radiator thermostats. ViLocal learns and retains per-thermostat motor bounds, shows estimates once the observed span exceeds 500 steps, and uses calibration sweeps to find the closed position sooner.
- Add **Lifetime Motor Steps** from the raw thermostat counter and **Firmware Version** from the reported software build ID.

## [3.3] - 2026-11-21

Add per-attribute MQTT reads and writes for `--router` in shared and dedicated setups. Publish successful reads and accepted write values to the existing EUI-based state topics. Upgrade ZBTK to 3.0.1 for attribute type lookup and encoding.

## [3.2] - 2026-11-21

Add `start.sh --router` for binary request and response over a local socket with a dedicated or shared adapter.

## [3.1] - 2026-11-21

Add optional shared-adapter router keepalive with `--router-keepalive MINUTES`. The `ember-router` pass-through format now uses binary a packets package format and requires `ember-router` 2.1 or later. Use of a generic `json` format stays available for custom consumers of ViLocals command output, but cannot be used for `ember-router` <2.1 any longer.

## [3.0] - 2026-11-19

> [!NOTE]
> This major release introduces support for controlling thermostats. In case you are already using an EmberZNet based adapter for capturing ZigBee traffic, the same adapter can be used for controlling your thermostats as well, following the set-up instructions in the documentation. Using a dedicated adapter for control is possible and recommended for more reliable operation. Both operation modes are described in the documentation.

Enable support for controlling climate controls for thermostats through ember-router. Bump dependencies and Yarn to latest versions.

## [2.5] - 2026-09-15

Add action to climate control for thermostats. Set minimum and maximum temperature limits, as well as the temperature unit for climate controls.

## [2.4] - 2026-08-30

Add `retain_state` option to configuration, which allows to retain the state of all thermostats / climate sensors in the MQTT broker. By default, neither ViLocal nor your MQTT broker will retain the state of the devices, which means that after a restart of your MQTT broker, re-publishing the state of all device attribute might take up to 24 hours, depending on how often the information is sent / captured by ViLocal.

Add support for `ZBTK_PARSE_FILTER_DST_PAN` environment variable, which allows to filter out all packets that are not destined for the configured PAN ID. This is useful if you have multiple ZigBee networks in range, and want to filter out all packets that are not destined for your configured PAN ID.

## [2.3] - 2026-08-03

Bump `zbtk` to 2.6 to fix publishing of unsafe EUI to address table.

## [2.2] - 2026-07-01

Add reference to Home Assistant app to README.md and bump dependencies with a new minimum Node.js version of 22.

## [2.1] - 2026-02-17

Add heating demand value to thermostat entities. The thermostats will indicate if there is a heating demand. "0" meaning off / no heating demand and "7" meaning maximum heating demand. This is a direct reading from the "PI Heating Demand" value of the thermostat, which is taken from the internal feedback loop. So the value does not necessarily correspond to the actual heating output / valve position of the thermostat, but rather a indication that the thermostat is noticing more heating is necessary to reach the set target temperature. Note, in the ViCare app, this value is used to indicate the little "red bubbles" for the thermostats.

## [2.0] - 2025-11-24

**Breaking Change:** Upgrade ZigBee Toolkit (ZBTK) to major version 2, implicitly requiring the minimum Node.js version to be 20 now. The major change in upgrading the toolkit version to 2, was that the toolkit no longer captures own data, but requires a piped-in (P)CAP stream. This opens up the framework (and ViLocal implicitly) for more [supported & tested capture devices](https://github.com/kristian/zbtk/blob/main/docs/tested-capture-devices.md). However this will require to change your ViLocal installation, to switch over to the new pipe mechanism. The old `device` (and `buffer_size`) options in the configuration are no longer supported.

## [1.2] - 2025-02-19

Add window open detection to thermostats.

## [1.1] - 2025-02-19

In addition to the climate platform, expose thermostat readings as sensors

## [1.0] - 2025-02-19

Initial release
