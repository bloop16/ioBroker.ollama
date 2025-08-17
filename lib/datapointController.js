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
    this.allowedDatapoints = allowedDatapoints; // For reading (getState)
    this.writeAllowedDatapoints = new Set(); // For writing (setState) - more restrictive
    this.log = log;
    this.translate = translateFn;
    this.datapointMapping = new Map(); // Maps short names to full IDs

    this.log.info(
      this.translate("general_initialized").replace(
        "{{component}}",
        "DatapointController",
      ),
    );
  }

  /**
   * Set allowed datapoints for reading (getState)
   *
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs for reading
   */
  setAllowedDatapoints(allowedDatapoints) {
    this.allowedDatapoints = allowedDatapoints;
    this._buildDatapointMapping();
    this.log.debug(
      `[DatapointController] Updated allowed datapoints for reading: ${allowedDatapoints.size} datapoints`,
    );
  }

  /**
   * Set allowed datapoints for writing (setState)
   *
   * @param {Set} writeAllowedDatapoints - Set of allowed datapoint IDs for writing
   */
  setWriteAllowedDatapoints(writeAllowedDatapoints) {
    this.writeAllowedDatapoints = writeAllowedDatapoints;
    this.log.info(
      `[DatapointController] Updated allowed datapoints for writing: ${writeAllowedDatapoints.size} datapoints`,
    );
    this.log.debug(
      `[DatapointController] Write-allowed datapoints: ${Array.from(writeAllowedDatapoints).join(", ")}`,
    );
  }

  /**
   * Debug function to check current configuration
   *
   * @param {string} datapointId - Datapoint ID to check
   */
  async debugDatapointConfig(datapointId) {
    this.log.debug(
      `[DatapointController] DEBUG: Configuration for ${datapointId}:`,
    );
    this.log.debug(
      `[DatapointController] - Is readable: ${this.allowedDatapoints.has(datapointId)}`,
    );
    this.log.debug(
      `[DatapointController] - Is writable: ${this.writeAllowedDatapoints.has(datapointId)}`,
    );
    this.log.debug(
      `[DatapointController] - Total readable datapoints: ${this.allowedDatapoints.size}`,
    );
    this.log.debug(
      `[DatapointController] - Total writable datapoints: ${this.writeAllowedDatapoints.size}`,
    );

    try {
      const obj = await this.adapter.getForeignObjectAsync(datapointId);
      const customConfig = obj?.common?.custom?.[this.adapter.namespace];
      this.log.debug(`[DatapointController] - Object exists: ${!!obj}`);
      this.log.debug(
        `[DatapointController] - Custom config: ${JSON.stringify(customConfig)}`,
      );
      this.log.debug(
        `[DatapointController] - allowAutoChange: ${customConfig?.allowAutoChange}`,
      );
    } catch (error) {
      this.log.error(
        `[DatapointController] - Error reading object: ${error.message}`,
      );
    }
  }

  /**
   * Build mapping from short names to full datapoint IDs
   */
  _buildDatapointMapping() {
    this.datapointMapping.clear();

    for (const fullId of this.allowedDatapoints) {
      // Extract the part after the last dot as short name
      const parts = fullId.split(".");
      const shortName = parts[parts.length - 1];

      // Store both the short name and variations
      this.datapointMapping.set(shortName, fullId);
      this.datapointMapping.set(shortName.toLowerCase(), fullId);

      // Also map with spaces instead of underscores
      const spacedName = shortName.replace(/_/g, " ");
      this.datapointMapping.set(spacedName, fullId);
      this.datapointMapping.set(spacedName.toLowerCase(), fullId);

      this.log.debug(
        `[DatapointController] Mapped "${shortName}" -> "${fullId}"`,
      );
    }
  }

  /**
   * Find the correct datapoint ID from various input formats
   *
   * @param {string} inputDatapoint - Input datapoint name/ID
   * @returns {string|null} Full datapoint ID or null if not found
   */
  _resolveDatapointId(inputDatapoint) {
    if (!inputDatapoint) {
      return null;
    }

    // First, check if it's already a full ID
    if (this.allowedDatapoints.has(inputDatapoint)) {
      return inputDatapoint;
    }

    // Check direct mapping
    if (this.datapointMapping.has(inputDatapoint)) {
      return this.datapointMapping.get(inputDatapoint);
    }

    // Check lowercase mapping
    const lowerInput = inputDatapoint.toLowerCase();
    if (this.datapointMapping.has(lowerInput)) {
      return this.datapointMapping.get(lowerInput);
    }

    // Fuzzy matching - find datapoint that contains the input
    for (const [shortName, fullId] of this.datapointMapping.entries()) {
      if (
        shortName.toLowerCase().includes(lowerInput) ||
        lowerInput.includes(shortName.toLowerCase())
      ) {
        this.log.debug(
          `[DatapointController] Fuzzy matched "${inputDatapoint}" -> "${fullId}"`,
        );
        return fullId;
      }
    }

    // Last resort: partial matching on full IDs
    for (const fullId of this.allowedDatapoints) {
      if (fullId.toLowerCase().includes(lowerInput)) {
        this.log.debug(
          `[DatapointController] Partial matched "${inputDatapoint}" -> "${fullId}"`,
        );
        return fullId;
      }
    }

    return null;
  }

  /**
   * Get current datapoint value
   *
   * @param {string} datapointId - Datapoint ID
   * @returns {Promise<object>} Result object with success status and value
   */
  async getDatapointValue(datapointId) {
    try {
      // Check if datapoint is allowed for reading
      if (
        this.allowedDatapoints.size > 0 &&
        !this.allowedDatapoints.has(datapointId)
      ) {
        this.log.warn(
          `[DatapointController] Datapoint ${datapointId} is not allowed for reading`,
        );
        return {
          success: false,
          error: `Datapoint not allowed for reading: ${datapointId}`,
          datapointId: datapointId,
        };
      }

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
   * @param {object} customConfig - Optional custom configuration for conversion
   * @returns {Promise<boolean>} Success status
   */
  async setDatapoint(datapointId, value, customConfig = {}) {
    try {
      // Check if datapoint is allowed for reading first
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

      // Check if datapoint is allowed for writing (more restrictive)
      if (
        this.writeAllowedDatapoints.size > 0 &&
        !this.writeAllowedDatapoints.has(datapointId)
      ) {
        this.log.warn(
          `[DatapointController] Datapoint ${datapointId} is readable but not writable. Writing requires allowAutoChange=true.`,
        );
        this.log.debug(
          `[DatapointController] Available write-allowed datapoints: ${Array.from(this.writeAllowedDatapoints).join(", ")}`,
        );
        return false;
      }

      // Get datapoint object to determine type
      const obj = await this.adapter.getForeignObjectAsync(datapointId);
      if (!obj || !obj.common) {
        this.log.error(
          this.translate("general_error_occurred").replace(
            "{{error}}",
            `Datapoint ${datapointId} not found`,
          ),
        );
        return false;
      }

      // Get custom configuration from datapoint object
      const datapointCustomConfig =
        obj.common.custom?.[this.adapter.namespace] || {};

      // Merge custom config with datapoint-specific config
      const mergedConfig = {
        ...customConfig,
        ...datapointCustomConfig,
        dataType: datapointCustomConfig.dataType || obj.common.type,
      };

      // Convert value to appropriate type
      const convertedValue = this.convertValue(
        value,
        obj.common.type,
        mergedConfig,
      );
      if (convertedValue === null) {
        this.log.error(
          this.translate("datapoint_type_conversion_failed")
            .replace("{{value}}", value)
            .replace("{{type}}", obj.common.type),
        );
        return false;
      }

      // Set the value
      await this.adapter.setForeignStateAsync(
        datapointId,
        convertedValue,
        true,
      );
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
      // Handle null/undefined values - try to infer from context
      if (value === null || value === undefined) {
        this.log.debug(
          `[DatapointController] Null value received for type ${targetType}, attempting smart conversion`,
        );
        return this._handleNullValue(targetType, customConfig);
      }

      switch (targetType) {
        case "boolean": {
          const boolResult = this.convertToBoolean(value, customConfig);
          if (
            boolResult === null &&
            (customConfig.booleanTrueValue || customConfig.booleanFalseValue)
          ) {
            // Failed to match custom values, don't convert
            this.log.error(
              `[DatapointController] Boolean conversion failed: "${value}" doesn't match custom values`,
            );
            return null;
          }
          return boolResult;
        }

        case "number":
          return this.convertToNumber(value, customConfig);

        case "text":
        case "string":
        default:
          return this.convertToString(value, customConfig);
      }
    } catch (_error) {
      this.log.warn(
        this.translate("datapoint_type_conversion_failed")
          .replace("{{value}}", value)
          .replace("{{type}}", targetType),
      );
      return null; // Return null instead of original value to indicate failed conversion
    }
  }

  /**
   * Handle null values by inferring appropriate defaults
   *
   * @param {string} targetType - Target data type
   * @param {object} customConfig - Custom configuration
   * @returns {*} Inferred value based on context
   */
  _handleNullValue(targetType, customConfig = {}) {
    switch (targetType) {
      case "boolean":
        // For presence datapoints, default to true (person is home)
        if (customConfig.isPresenceDatapoint) {
          this.log.debug(
            "[DatapointController] Inferring boolean true for presence datapoint",
          );
          return true;
        }
        return false;

      case "number":
        return 0;

      case "text":
      case "string":
      default:
        return "";
    }
  }

  /**
   * Convert to boolean using primarily custom configuration values
   *
   * @param {*} value - Input value
   * @param {object} customConfig - Custom configuration
   * @returns {boolean|null} Boolean value or null if conversion failed
   */
  convertToBoolean(value, customConfig = {}) {
    if (typeof value === "boolean") {
      return value;
    }

    const valueStr = String(value).toLowerCase().trim();

    // If custom boolean values are defined, use them as primary parsing reference
    if (customConfig.booleanTrueValue || customConfig.booleanFalseValue) {
      return this._parseWithCustomValues(valueStr, customConfig);
    }

    // Fallback for datapoints without custom values - use minimal universal parsing
    return this._parseUniversalBoolean(valueStr);
  }

  /**
   * Parse boolean using custom configuration values as reference
   *
   * @param {string} valueStr - Lowercase trimmed string value
   * @param {object} customConfig - Custom configuration with booleanTrueValue/booleanFalseValue
   * @returns {boolean|null} Boolean value or null if conversion failed
   */
  _parseWithCustomValues(valueStr, customConfig) {
    // Step 1: Direct exact match with custom values
    if (customConfig.booleanTrueValue) {
      const trueValue = String(customConfig.booleanTrueValue)
        .toLowerCase()
        .trim();
      if (valueStr === trueValue) {
        this.log.debug(
          `[DatapointController] Exact match custom true: "${valueStr}" -> true`,
        );
        return true;
      }
    }

    if (customConfig.booleanFalseValue) {
      const falseValue = String(customConfig.booleanFalseValue)
        .toLowerCase()
        .trim();
      if (valueStr === falseValue) {
        this.log.debug(
          `[DatapointController] Exact match custom false: "${valueStr}" -> false`,
        );
        return false;
      }
    }

    // Step 2: Partial/fuzzy match with custom values
    if (customConfig.booleanTrueValue) {
      const trueValue = String(customConfig.booleanTrueValue)
        .toLowerCase()
        .trim();
      if (valueStr.includes(trueValue) || trueValue.includes(valueStr)) {
        this.log.debug(
          `[DatapointController] Fuzzy match custom true: "${valueStr}" contains/matches "${trueValue}" -> true`,
        );
        return true;
      }
    }

    if (customConfig.booleanFalseValue) {
      const falseValue = String(customConfig.booleanFalseValue)
        .toLowerCase()
        .trim();
      if (valueStr.includes(falseValue) || falseValue.includes(valueStr)) {
        this.log.debug(
          `[DatapointController] Fuzzy match custom false: "${valueStr}" contains/matches "${falseValue}" -> false`,
        );
        return false;
      }
    }

    // Step 3: Try to infer from universal boolean values and map to custom values
    const universalResult = this._parseUniversalBoolean(valueStr);
    if (universalResult !== null) {
      this.log.debug(
        `[DatapointController] Universal boolean conversion: "${valueStr}" -> ${universalResult ? customConfig.booleanTrueValue || "true" : customConfig.booleanFalseValue || "false"} (interpreted as ${universalResult})`,
      );
      return universalResult;
    }

    // Step 4: Could not parse - log detailed information
    this.log.warn(
      `[DatapointController] Cannot parse "${valueStr}" as boolean. Expected values: true="${customConfig.booleanTrueValue}", false="${customConfig.booleanFalseValue}", or universal values (true/false, 1/0)`,
    );
    return null;
  }

  /**
   * Parse universal boolean values (minimal fallback)
   *
   * @param {string} valueStr - Lowercase trimmed string value
   * @returns {boolean|null} Boolean value or null if parsing failed
   */
  _parseUniversalBoolean(valueStr) {
    // Only the most universal boolean representations
    const universalTrue = ["true", "1", "yes", "ja"];
    const universalFalse = ["false", "0", "no", "nein"];

    if (universalTrue.includes(valueStr)) {
      return true;
    }
    if (universalFalse.includes(valueStr)) {
      return false;
    }

    // Numeric conversion as last resort
    if (!isNaN(Number(valueStr))) {
      return Number(valueStr) !== 0;
    }

    return null;
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
   * Get function definitions for AI Function Calling (OpenAI-compatible)
   * Returns tools/functions that AI models can directly invoke
   *
   * @returns {Array} Array of function definitions
   */
  getFunctionDefinitions() {
    if (this.allowedDatapoints.size === 0) {
      return [];
    }

    // Create readable datapoint list for LLM with custom values
    const datapointList = Array.from(this.allowedDatapoints)
      .map((fullId) => {
        const parts = fullId.split(".");
        const shortName = parts[parts.length - 1];
        return `${shortName} (${fullId})`;
      })
      .join(", ");

    return [
      {
        type: "function",
        function: {
          name: "setState",
          description: `Set the state of an ioBroker datapoint to control smart home devices. The system automatically converts between different value formats (true/false, 1/0, custom words). For boolean datapoints with custom values, you can use either standard boolean values (true/false, 1/0, yes/no, ja/nein) or the custom words. For temperature datapoints like 'Temperatur_Wohnzimmer', this sets the actual temperature value, not heating control. You can use either the short name (e.g., 'Anwesenheit_Martin') or full ID. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description:
                  "The name or ID of the datapoint to control. Examples: 'Anwesenheit_Martin' for presence, 'Temperatur_Wohnzimmer' for room temperature value",
              },
              value: {
                type: ["boolean", "number", "string"],
                description:
                  "The new value to set. For boolean datapoints you can use: true/false, 1/0, yes/no, ja/nein, on/off, ein/aus, or any custom words defined for that datapoint. The system will automatically convert between formats. For temperature datapoints use numbers (e.g., 23.5)",
              },
            },
            required: ["datapoint", "value"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getState",
          description: `Get the current state of an ioBroker datapoint. For calculations like averages, call this function multiple times or use RAG context data to get historical values, then calculate yourself. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description:
                  "The name or ID of the datapoint to read. You can use short names like 'Anwesenheit_Martin' or 'Temperatur_Wohnzimmer'",
              },
            },
            required: ["datapoint"],
          },
        },
      },
    ];
  }

  /**
   * Execute a function call from AI Function Calling
   *
   * @param {string} functionName - Name of the function to execute
   * @param {object} parameters - Parameters for the function
   * @returns {Promise<object>} Result of the function execution
   */
  async executeFunctionCall(functionName, parameters) {
    this.log.info(
      `[DatapointController] Executing function call: ${functionName} with parameters:`,
      parameters,
    );

    switch (functionName) {
      case "setState":
        return await this.executeSetState(parameters);
      case "getState":
        return await this.executeGetState(parameters);
      // Legacy compatibility
      case "set_datapoint":
        return await this.executeSetState({
          datapoint: parameters.datapoint,
          value: parameters.value,
        });
      default:
        throw new Error(`Unknown function: ${functionName}`);
    }
  }

  /**
   * Execute setState function
   *
   * @param {object} parameters - Function parameters
   * @returns {Promise<object>} Result of the operation
   */
  async executeSetState(parameters) {
    const { datapoint, value } = parameters;

    if (!datapoint) {
      throw new Error("Missing required parameter: datapoint");
    }

    if (value === undefined || value === null) {
      this.log.warn(
        `[DatapointController] SAFETY CHECK: Rejected setState with null/undefined value for datapoint: ${datapoint}`,
      );
      throw new Error(
        `SAFETY ERROR: Cannot set datapoint ${datapoint} to null/undefined value. Please provide a valid value.`,
      );
    }

    // Resolve the datapoint ID
    const resolvedDatapoint = this._resolveDatapointId(datapoint);
    if (!resolvedDatapoint) {
      this.log.warn(
        `[DatapointController] Could not resolve datapoint: "${datapoint}". Available: ${Array.from(this.allowedDatapoints).join(", ")}`,
      );
      throw new Error(`Datapoint not allowed: ${datapoint}`);
    }

    this.log.debug(
      `[DatapointController] Resolved "${datapoint}" -> "${resolvedDatapoint}"`,
    );

    try {
      // Get custom configuration for this specific datapoint
      const obj = await this.adapter.getForeignObjectAsync(resolvedDatapoint);
      const customConfig = obj?.common?.custom?.[this.adapter.namespace] || {};

      const success = await this.setDatapoint(
        resolvedDatapoint,
        value,
        customConfig,
      );

      if (success) {
        return {
          success: true,
          datapoint: resolvedDatapoint,
          originalInput: datapoint,
          value: value,
          message: `Successfully set ${resolvedDatapoint} to ${value}`,
        };
      }

      // If setting failed, provide debug information
      await this.debugDatapointConfig(resolvedDatapoint);
      throw new Error("Failed to set datapoint value");
    } catch (error) {
      this.log.error(
        `[DatapointController] Error setting ${resolvedDatapoint}: ${error.message}`,
      );
      throw new Error(`Failed to set ${resolvedDatapoint}: ${error.message}`);
    }
  }

  /**
   * Execute getState function
   *
   * @param {object} parameters - Function parameters
   * @returns {Promise<object>} Result of the operation
   */
  async executeGetState(parameters) {
    const { datapoint } = parameters;

    if (!datapoint) {
      throw new Error("Missing required parameter: datapoint");
    }

    // Resolve the datapoint ID
    const resolvedDatapoint = this._resolveDatapointId(datapoint);
    if (!resolvedDatapoint) {
      this.log.warn(
        `[DatapointController] Could not resolve datapoint: "${datapoint}". Available: ${Array.from(this.allowedDatapoints).join(", ")}`,
      );
      throw new Error(`Datapoint not found: ${datapoint}`);
    }

    this.log.debug(
      `[DatapointController] Resolved "${datapoint}" -> "${resolvedDatapoint}"`,
    );

    try {
      const result = await this.getDatapointValue(resolvedDatapoint);

      if (result.success) {
        return {
          success: true,
          datapoint: resolvedDatapoint,
          originalInput: datapoint,
          value: result.value,
          timestamp: result.timestamp,
          message: `Current value of ${resolvedDatapoint} is ${result.value}`,
        };
      }
      throw new Error(result.error || "Failed to read datapoint");
    } catch (error) {
      this.log.error(
        `[DatapointController] Error reading ${resolvedDatapoint}: ${error.message}`,
      );
      throw new Error(`Failed to read ${resolvedDatapoint}: ${error.message}`);
    }
  }
}

module.exports = DatapointController;
