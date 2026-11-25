export const translations = {
  de: {
    deviceTypes: {
      thermostat: 'Heizkörperthermostat',
      floor_controller: 'Fußbodenthermostat',
      floor_thermostat: 'Fußbodenthermostat-Zone',
      climate_sensor: 'Klimasensor'
    },
    components: {
      heating_setpoint: { name: 'Solltemperatur' },
      temperature: { name: 'Temperatur' },
      window_open: { name: 'Fenster Offen' },
      external_window_open: { name: 'Fenster Offen (extern)' },
      heating_demand: { name: 'Heizbedarf' },
      valve_position: { name: 'Ventilstellung' },
      target_valve_position: { name: 'Ventil-Sollstellung' },
      motor_steps: { name: 'Motorschritte Gesamt', unit_of_measurement: 'Schritte' },
      identification_mode: { name: 'Identifikationsmodus' },
      installation_mode: { name: 'Montagemodus' },
      child_lock: { name: 'Kindersicherung' },
      supply_temperature: { name: 'Vorlauftemperatur' },
      requested_output_level: { name: 'Ausgangslevel-Sollwert' },
      output_active: { name: 'Ausgangslevel' },
      humidity: { name: 'Luftfeuchtigkeit' },
      battery_level: { name: 'Batteriestand' },
      link_quality: { name: 'Verbindungsqualität' },
      signal_strength: { name: 'Signalstärke' },
      firmware_version: { name: 'Firmware-Version' }
    }
  }
};

export function resolveLanguage(code) {
  return code?.split(':').map(locale => locale.trim().toLowerCase().split(/[-_.@]/, 1)[0])
    .find(code => code === 'en' || Object.hasOwn(translations, code)) ?? 'en';
}
