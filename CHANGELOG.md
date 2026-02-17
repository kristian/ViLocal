# Changelog

This file documents all *major & minor* releases. For revisions, please consult the [commit history](https://github.com/kristian/ViLocal/commits/main).

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
