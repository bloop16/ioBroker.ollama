"use strict";

/**
 * Datapoint Controller with ioBroker i18n support
 * Handles setting datapoint values with type conversion and validation
 */
class DatapointController {
  /**
   * Create a new DatapointController
   *
   * @param {object} adapter - The ioBroker adapter instance
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs
   * @param {object} log - Logger instance
   * @param {Function} translateFn - Translation function
   */
  constructor(
    adapter,
    allowedDatapoints = new Set(),
    log = console,
    translateFn = (key) => key,
  ) {
    this.adapter = adapter;
    this.allowedDatapoints = allowedDatapoints;
    this.log = log;
    this.translate = translateFn;

    this.log.info(
      this.translate("general_initialized").replace(
        "{{component}}",
        "DatapointController",
      ),
    );
  }

  /**
   * Set allowed datapoints for automatic control
   *
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs
   */
  setAllowedDatapoints(allowedDatapoints) {
    this.allowedDatapoints = allowedDatapoints;
    this.log.debug(
      `[DatapointController] Updated allowed datapoints: ${allowedDatapoints.size} datapoints`,
    );
  }

  /**
   * Get current datapoint value
   *
   * @param {string} datapointId - Datapoint ID
   * @returns {Promise<object>} Result object with success status and value
   */
  async getDatapointValue(datapointId) {
    try {
      const state = await this.adapter.getForeignStateAsync(datapointId);
      if (state) {
        return {
          success: true,
          value: state.val,
          timestamp: state.ts,
          datapointId: datapointId,
        };
      }
      return {
        success: false,
        error: "Datapoint not found or no value",
        datapointId: datapointId,
      };
    } catch (error) {
      this.log.error(
        `[DatapointController] Error getting value for ${datapointId}: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
        datapointId: datapointId,
      };
    }
  }

  /**
   * Set datapoint value with automatic type conversion
   *
   * @param {string} datapointId - Datapoint ID
   * @param {*} value - Value to set
   * @returns {Promise<boolean>} Success status
   */
  async setDatapoint(datapointId, value) {
    try {
      // Check if datapoint is allowed for automatic control
      if (
        this.allowedDatapoints.size > 0 &&
        !this.allowedDatapoints.has(datapointId)
      ) {
        this.log.warn(
          this.translate("datapoint_not_allowed").replace(
            "{{datapoint}}",
            datapointId,
          ),
        );
        return false;
      }

      // Get datapoint object to determine type
      const obj = await this.adapter.getObjectAsync(datapointId);
      if (!obj || !obj.common) {
        this.log.error(
          this.translate("general_error_occurred").replace(
            "{{error}}",
            `Datapoint ${datapointId} not found`,
          ),
        );
        return false;
      }

      // Convert value to appropriate type
      const convertedValue = this.convertValue(value, obj.common.type);
      if (convertedValue === null) {
        this.log.error(
          this.translate("datapoint_type_conversion_failed")
            .replace("{{value}}", value)
            .replace("{{type}}", obj.common.type),
        );
        return false;
      }

      // Set the value
      await this.adapter.setStateAsync(datapointId, convertedValue, true);
      this.log.info(
        this.translate("datapoint_set_success")
          .replace("{{datapoint}}", datapointId)
          .replace("{{value}}", convertedValue),
      );
      return true;
    } catch (error) {
      this.log.error(
        this.translate("datapoint_set_failed")
          .replace("{{datapoint}}", datapointId)
          .replace("{{error}}", error.message),
      );
      return false;
    }
  }

  /**
   * Convert value to appropriate type with localized support
   *
   * @param {*} value - Input value
   * @param {string} targetType - Target data type
   * @param {object} customConfig - Custom configuration
   * @returns {*} Converted value or null if conversion failed
   */
  convertValue(value, targetType, customConfig = {}) {
    try {
      switch (targetType) {
        case "boolean":
          return this.convertToBoolean(value, customConfig);

        case "number":
          return this.convertToNumber(value, customConfig);

        case "text":
        case "string":
        default:
          return this.convertToString(value, customConfig);
      }
    } catch {
      this.log.warn(
        this.translate("datapoint_type_conversion_failed")
          .replace("{{value}}", value)
          .replace("{{type}}", targetType),
      );
      return value; // Return original value on conversion error
    }
  }

  /**
   * Convert to boolean with multilingual presence/state awareness
   *
   * @param {*} value - Input value
   * @param {object} _customConfig - Custom configuration
   * @returns {boolean|null} Boolean value or null if conversion failed
   */
  convertToBoolean(value, _customConfig) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const lowerValue = value.toLowerCase().trim();

      // Multilingual boolean keywords
      const presenceTrue = [
        // English
        "true",
        "on",
        "1",
        "yes",
        "home",
        "present",
        "available",
        "here",
        "arrived",
        // German
        "wahr",
        "ein",
        "an",
        "ja",
        "zuhause",
        "anwesend",
        "verfügbar",
        "da",
        "angekommen",
        // French
        "vrai",
        "allumé",
        "oui",
        "maison",
        "présent",
        "disponible",
        "ici",
        "arrivé",
        // Spanish
        "verdadero",
        "encendido",
        "sí",
        "casa",
        "presente",
        "disponible",
        "aquí",
        "llegado",
      ];

      const presenceFalse = [
        // English
        "false",
        "off",
        "0",
        "no",
        "away",
        "absent",
        "gone",
        "left",
        // German
        "falsch",
        "aus",
        "ab",
        "nein",
        "weg",
        "abwesend",
        "fort",
        "verlassen",
        // French
        "faux",
        "éteint",
        "non",
        "absent",
        "parti",
        "quitté",
        // Spanish
        "falso",
        "apagado",
        "no",
        "ausente",
        "ido",
        "salido",
      ];

      if (presenceTrue.some((keyword) => lowerValue.includes(keyword))) {
        return true;
      }
      if (presenceFalse.some((keyword) => lowerValue.includes(keyword))) {
        return false;
      }

      // Standard string to boolean conversion
      return !["", "0", "false", "off"].includes(lowerValue);
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    return Boolean(value);
  }

  /**
   * Convert to number
   *
   * @param {*} value - Input value
   * @param {object} _customConfig - Custom configuration
   * @returns {number} Number value
   */
  convertToNumber(value, _customConfig) {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string") {
      const numMatch = value.match(/(-?\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFloat(numMatch[1].replace(",", "."));
      }
    }

    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }

    return 0;
  }

  /**
   * Convert to string with localized boolean representation
   *
   * @param {*} value - Input value
   * @param {object} _customConfig - Custom configuration
   * @returns {string} String value
   */
  convertToString(value, _customConfig) {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "boolean") {
      return value
        ? this.translate("datapoint_boolean_true")
        : this.translate("datapoint_boolean_false");
    }

    return String(value);
  }

  /**
   * Get function definitions for OpenWebUI tool calling
   *
   * @returns {Array} Function definitions
   */
  getFunctionDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "set_datapoint",
          description: this.translate("general_operation_complete"),
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description: "ID of the datapoint to set",
              },
              value: {
                type: ["string", "number", "boolean"],
                description: "Value to set the datapoint to",
              },
            },
            required: ["datapoint", "value"],
          },
        },
      },
    ];
  }

  /**
   * Handle function call from OpenWebUI
   *
   * @param {string} functionName - Name of the function
   * @param {object} args - Function arguments
   * @returns {Promise<object>} Function result
   */
  async handleFunctionCall(functionName, args) {
    switch (functionName) {
      case "set_datapoint": {
        const success = await this.setDatapoint(args.datapoint, args.value);
        return {
          success: success,
          message: success
            ? this.translate("datapoint_set_success")
                .replace("{{datapoint}}", args.datapoint)
                .replace("{{value}}", args.value)
            : this.translate("datapoint_set_failed")
                .replace("{{datapoint}}", args.datapoint)
                .replace("{{error}}", "Operation failed"),
        };
      }
      default:
        return {
          success: false,
          message: this.translate("general_not_available").replace(
            "{{feature}}",
            functionName,
          ),
        };
    }
  }
}

module.exports = DatapointController;
