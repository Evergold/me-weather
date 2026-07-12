// landmarks.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

/**
 * Middle-earth landmarks management
 * Contains pre-configured locations and handles custom user-placed pins.
 * Persists custom stations to localStorage.
 */

export const PRESET_LANDMARKS = [
  { id: 'hobbiton', name: 'Hobbiton', x: 0.30, y: 0.30, type: 'Shire', isPreset: true },
  { id: 'grey-havens', name: 'Grey Havens', x: 0.15, y: 0.28, type: 'Gulf of Lhûn', isPreset: true },
  { id: 'rivendell', name: 'Rivendell', x: 0.46, y: 0.28, type: 'Eriador foothills', isPreset: true },
  { id: 'moria', name: 'Moria', x: 0.48, y: 0.38, type: 'Misty Mountains', isPreset: true },
  { id: 'isengard', name: 'Isengard', x: 0.47, y: 0.54, type: 'Nan Curunír', isPreset: true },
  { id: 'helms-deep', name: 'Helm\'s Deep', x: 0.51, y: 0.58, type: 'Rohan valleys', isPreset: true },
  { id: 'edoras', name: 'Edoras', x: 0.55, y: 0.62, type: 'Rohan plains', isPreset: true },
  { id: 'minas-tirith', name: 'Minas Tirith', x: 0.68, y: 0.68, type: 'Anórien', isPreset: true },
  { id: 'barad-dur', name: 'Barad-dûr', x: 0.83, y: 0.66, type: 'Mordor', isPreset: true },
  { id: 'mount-doom', name: 'Mount Doom', x: 0.80, y: 0.67, type: 'Orodruin', isPreset: true }
];

export class LandmarkManager {
  constructor() {
    this.customPins = this.loadCustomPins();
  }

  /**
   * Load custom pins from localStorage
   */
  loadCustomPins() {
    try {
      const stored = localStorage.getItem('me_weather_custom_pins');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error('Failed to load custom pins from localStorage', e);
      return [];
    }
  }

  /**
   * Save custom pins to localStorage
   */
  saveCustomPins() {
    try {
      localStorage.setItem('me_weather_custom_pins', JSON.stringify(this.customPins));
    } catch (e) {
      console.error('Failed to save custom pins to localStorage', e);
    }
  }

  /**
   * Returns a merged array of preset landmarks and custom pins
   */
  getAll() {
    return [...PRESET_LANDMARKS, ...this.customPins];
  }

  /**
   * Adds a custom user-placed pin
   * @param {string} name 
   * @param {number} x Normalized X coordinate [0, 1]
   * @param {number} y Normalized Y coordinate [0, 1]
   */
  addCustomPin(name, x, y) {
    const id = 'custom-' + Date.now();
    const newPin = {
      id: id,
      name: name,
      x: x,
      y: y,
      type: 'Custom Station',
      isPreset: false
    };
    this.customPins.push(newPin);
    this.saveCustomPins();
    return newPin;
  }

  /**
   * Removes a custom pin by ID
   */
  removeCustomPin(id) {
    this.customPins = this.customPins.filter(pin => pin.id !== id);
    this.saveCustomPins();
  }

  /**
   * Clears all custom pins
   */
  clearCustomPins() {
    this.customPins = [];
    this.saveCustomPins();
  }

  /**
   * Computes the weather data for all landmarks based on the current physics model
   */
  updateLandmarkWeather(physics) {
    const landmarks = this.getAll();
    return landmarks.map(landmark => {
      const weather = physics.getWeatherAt(landmark.x, landmark.y);
      return {
        ...landmark,
        weather: weather
      };
    });
  }
}
