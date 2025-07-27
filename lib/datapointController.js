"use strict";

class DatapointController {
    /**
     * Creates an instance of DatapointController
     * @param {ioBroker.Adapter} adapter
     * @param {object} log
     */
    constructor(adapter, log) {
        this.adapter = adapter;
        this.log = log;
        this.allowedDatapoints = new Set(); // Set of allowed datapoint IDs
        this.availableFunctions = this.initializeFunctions();
    }

    /**
     * Initialize available functions for AI model
     * @returns {Array<Object>}
     */
    initializeFunctions() {
        return [
            {
                name: "setDatapointValue",
                description: "Set the value of a datapoint in ioBroker system",
                parameters: {
                    type: "object",
                    properties: {
                        datapointId: {
                            type: "string",
                            description: "The ID of the datapoint to set (e.g., '0_userdata.0.Martin')"
                        },
                        value: {
                            type: ["string", "number", "boolean"],
                            description: "The value to set for the datapoint"
                        }
                    },
                    required: ["datapointId", "value"]
                }
            },
            {
                name: "getDatapointValue",
                description: "Get the current value of a datapoint",
                parameters: {
                    type: "object",
                    properties: {
                        datapointId: {
                            type: "string",
                            description: "The ID of the datapoint to get"
                        }
                    },
                    required: ["datapointId"]
                }
            },
            {
                name: "searchDatapoints",
                description: "Search for datapoints based on name, description, or location",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Search query (name, description, or location)"
                        },
                        type: {
                            type: "string",
                            enum: ["boolean", "number", "string"],
                            description: "Filter by datapoint type"
                        },
                        location: {
                            type: "string",
                            description: "Filter by location"
                        }
                    },
                    required: ["query"]
                }
            },
            {
                name: "incrementDatapoint",
                description: "Increment a numeric datapoint by a specific amount",
                parameters: {
                    type: "object",
                    properties: {
                        datapointId: {
                            type: "string",
                            description: "The ID of the numeric datapoint to increment"
                        },
                        amount: {
                            type: "number",
                            description: "Amount to increment by (can be negative to decrement)"
                        }
                    },
                    required: ["datapointId", "amount"]
                }
            }
        ];
    }

    /**
     * Get function definitions for AI model in Ollama format
     * @returns {Array<Object>}
     */
    getFunctionDefinitions() {
        return this.availableFunctions.map(func => ({
            type: "function",
            function: {
                name: func.name,
                description: func.description,
                parameters: func.parameters
            }
        }));
    }

    /**
     * Process AI function call
     * @param {string} functionName
     * @param {Object} parameters
     * @param {string} modelId
     * @returns {Promise<Object>}
     */
    async executeFunctionCall(functionName, parameters, modelId) {
        this.log.debug(`[DatapointController] Function call: ${functionName} with params: ${JSON.stringify(parameters)} from model: ${modelId}`);

        try {
            switch (functionName) {
                case "setDatapointValue":
                    return await this.handleSetDatapointValue(parameters, modelId);
                case "getDatapointValue":
                    return await this.handleGetDatapointValue(parameters, modelId);
                case "searchDatapoints":
                    return await this.handleSearchDatapoints(parameters, modelId);
                case "incrementDatapoint":
                    return await this.handleIncrementDatapoint(parameters, modelId);
                default:
                    throw new Error(`Unknown function: ${functionName}`);
            }
        } catch (error) {
            this.log.error(`[DatapointController] Error executing function ${functionName}: ${error.message}`);
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Handle setDatapointValue function call
     * @param {Object} parameters
     * @param {string} modelId
     * @returns {Promise<Object>}
     */
    async handleSetDatapointValue(parameters, modelId) {
        const { datapointId, value } = parameters;

        this.log.info(`[DatapointController] Model ${modelId} requests to set ${datapointId} to "${value}"`);

        // Check if datapoint is allowed
        if (!this.allowedDatapoints.has(datapointId)) {
            const error = `Datapoint ${datapointId} is not allowed for automatic changes. Enable 'Allow automatic state changes' in custom config.`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        // Validate datapoint exists and is writable
        const obj = await this.adapter.getForeignObjectAsync(datapointId);
        if (!obj) {
            const error = `Datapoint ${datapointId} not found`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        // Check if writable (using bracket notation for type safety)
        if (obj.common && obj.common['write'] === false) {
            const error = `Datapoint ${datapointId} is not writable`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        // Get current state for logging
        const currentState = await this.adapter.getForeignStateAsync(datapointId);
        const previousValue = currentState ? currentState.val : null;

        // Get custom configuration for intelligent conversion
        const customConfig = obj.common?.custom?.[this.adapter.namespace] || {};
        this.log.debug(`[DatapointController] Custom config for ${datapointId}:`, customConfig);

        // Convert value to appropriate type with intelligent processing
        const targetType = (obj.common && obj.common['type']) ? obj.common['type'] : 'string';
        const convertedValue = this.convertValue(value, targetType, customConfig);

        this.log.info(`[DatapointController] Value conversion: "${value}" (${typeof value}) → "${convertedValue}" (${typeof convertedValue}) for type ${targetType}`);

        // Set the value
        await this.adapter.setForeignStateAsync(datapointId, convertedValue, false);

        const successMessage = `Model ${modelId} successfully changed ${datapointId} from ${previousValue} to ${convertedValue}`;
        this.log.info(`[DatapointController] ${successMessage}`);

        // Return detailed response for debugging
        return {
            success: true,
            datapointId: datapointId,
            originalValue: value,
            convertedValue: convertedValue,
            previousValue: previousValue,
            targetType: targetType,
            customConfig: customConfig,
            timestamp: new Date().toISOString(),
            modelId: modelId,
            message: successMessage
        };
    }

    /**
     * Handle getDatapointValue function call
     * @param {Object} parameters
     * @param {string} modelId
     * @returns {Promise<Object>}
     */
    async handleGetDatapointValue(parameters, modelId) {
        const { datapointId } = parameters;

        const state = await this.adapter.getForeignStateAsync(datapointId);
        if (!state) {
            throw new Error(`Datapoint ${datapointId} not found or no state available`);
        }

        return {
            success: true,
            datapointId: datapointId,
            value: state.val,
            timestamp: new Date(state.ts).toISOString(),
            acknowledged: state.ack,
            modelId: modelId
        };
    }

    /**
     * Handle searchDatapoints function call
     * @param {Object} parameters
     * @param {string} modelId
     * @returns {Promise<Object>}
     */
    async handleSearchDatapoints(parameters, modelId) {
        const { query, type, location } = parameters;

        try {
            // Get all objects to search through
            const objects = await this.adapter.getObjectViewAsync('system', 'state', {});
            
            if (!objects || !objects.rows) {
                return {
                    success: true,
                    results: [],
                    count: 0,
                    modelId: modelId
                };
            }

            const results = [];
            const searchQuery = query.toLowerCase();
            
            for (const row of objects.rows) {
                const obj = row.value;
                const objId = row.id;
                
                if (!obj || !obj.common) continue;
                
                // Skip own adapter states
                if (objId.startsWith(this.adapter.namespace + '.')) continue;
                
                const name = (obj.common.name || '').toString().toLowerCase();
                const customConfig = obj.common.custom?.[this.adapter.namespace];
                const description = customConfig?.description || '';
                const datapointLocation = customConfig?.location || '';
                
                // Check if matches search criteria
                let matches = false;
                
                // Search in name, description, or ID
                if (name.includes(searchQuery) || 
                    description.toLowerCase().includes(searchQuery) || 
                    objId.toLowerCase().includes(searchQuery)) {
                    matches = true;
                }
                
                // Apply filters
                if (matches && type && obj.common.type !== type) {
                    matches = false;
                }
                
                if (matches && location && !datapointLocation.toLowerCase().includes(location.toLowerCase())) {
                    matches = false;
                }
                
                if (matches) {
                    results.push({
                        id: objId,
                        name: obj.common.name || '',
                        type: obj.common.type || 'unknown',
                        role: obj.common.role || '',
                        description: description,
                        location: datapointLocation,
                        writable: obj.common.write !== false,
                        allowedForAutoChange: this.allowedDatapoints.has(objId)
                    });
                }
            }

            return {
                success: true,
                results: results.slice(0, 20), // Limit results
                count: results.length,
                query: query,
                modelId: modelId
            };
            
        } catch (error) {
            throw new Error(`Search failed: ${error.message}`);
        }
    }

    /**
     * Handle incrementDatapoint function call
     * @param {Object} parameters
     * @param {string} modelId
     * @returns {Promise<Object>}
     */
    async handleIncrementDatapoint(parameters, modelId) {
        const { datapointId, amount } = parameters;

        this.log.info(`[DatapointController] Model ${modelId} requests to increment ${datapointId} by ${amount}`);

        // Check if datapoint is allowed
        if (!this.allowedDatapoints.has(datapointId)) {
            const error = `Datapoint ${datapointId} is not allowed for automatic changes. Enable 'Allow automatic state changes' in custom config.`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        // Get current value
        const currentState = await this.adapter.getForeignStateAsync(datapointId);
        if (!currentState) {
            const error = `Datapoint ${datapointId} not found or no state available`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        const currentValue = parseFloat(String(currentState.val));
        if (isNaN(currentValue)) {
            const error = `Datapoint ${datapointId} does not contain a numeric value (current: ${currentState.val})`;
            this.log.error(`[DatapointController] ${error}`);
            throw new Error(error);
        }

        const newValue = currentValue + amount;
        
        this.log.info(`[DatapointController] Incrementing ${datapointId}: ${currentValue} + ${amount} = ${newValue}`);
        
        // Set new value
        await this.adapter.setForeignStateAsync(datapointId, newValue, false);

        const successMessage = `Model ${modelId} successfully incremented ${datapointId} by ${amount} (${currentValue} → ${newValue})`;
        this.log.info(`[DatapointController] ${successMessage}`);

        return {
            success: true,
            datapointId: datapointId,
            previousValue: currentValue,
            increment: amount,
            newValue: newValue,
            timestamp: new Date().toISOString(),
            modelId: modelId,
            message: successMessage
        };
    }

    /**
     * Convert value to appropriate type with intelligent natural language processing
     * @param {*} value
     * @param {string} targetType
     * @param {Object} customConfig - Custom configuration for the datapoint
     * @returns {*}
     */
    convertValue(value, targetType, customConfig = {}) {
        this.log.debug(`[DatapointController] Converting value "${value}" to type "${targetType}" with config:`, customConfig);
        
        switch (targetType) {
            case 'boolean':
                return this.convertToBoolean(value, customConfig);
            case 'number':
                return this.convertToNumber(value, customConfig);
            case 'string':
                return this.convertToString(value, customConfig);
            default:
                this.log.debug(`[DatapointController] Unknown target type "${targetType}", returning as string`);
                return String(value);
        }
    }

    /**
     * Intelligent boolean conversion supporting multiple languages
     * @param {*} value
     * @param {Object} customConfig
     * @returns {boolean}
     */
    convertToBoolean(value, customConfig) {
        if (typeof value === 'boolean') {
            this.log.debug(`[DatapointController] Boolean value passed through: ${value}`);
            return value;
        }

        // Use custom true/false values if defined
        if (customConfig.booleanTrueValue && customConfig.booleanFalseValue) {
            const stringValue = String(value).toLowerCase();
            const trueValue = String(customConfig.booleanTrueValue || 'true').toLowerCase();
            const falseValue = String(customConfig.booleanFalseValue || 'false').toLowerCase();
            
            if (stringValue === trueValue) {
                this.log.info(`[DatapointController] Custom boolean conversion: "${value}" → true (matches custom true value)`);
                return true;
            }
            if (stringValue === falseValue) {
                this.log.info(`[DatapointController] Custom boolean conversion: "${value}" → false (matches custom false value)`);
                return false;
            }
        }

        // Intelligent multilingual boolean detection
        const stringValue = String(value).toLowerCase().trim();
        
        // Common positive indicators (multilingual)
        const positiveIndicators = [
            // German
            'ja', 'wahr', 'an', 'ein', 'aktiv', 'anwesend', 'da', 'zuhause', 'offen', 'geöffnet',
            // English  
            'yes', 'true', 'on', 'active', 'present', 'home', 'open', 'opened',
            // Generic
            '1', 'enabled', 'enable'
        ];

        // Common negative indicators (multilingual)
        const negativeIndicators = [
            // German
            'nein', 'falsch', 'aus', 'inaktiv', 'abwesend', 'weg', 'nicht da', 'geschlossen', 'zu',
            // English
            'no', 'false', 'off', 'inactive', 'absent', 'away', 'closed',
            // Generic
            '0', 'disabled', 'disable'
        ];

        if (positiveIndicators.includes(stringValue)) {
            this.log.info(`[DatapointController] Intelligent boolean conversion: "${value}" → true (positive indicator detected)`);
            return true;
        }
        
        if (negativeIndicators.includes(stringValue)) {
            this.log.info(`[DatapointController] Intelligent boolean conversion: "${value}" → false (negative indicator detected)`);
            return false;
        }

        // Fallback to standard boolean conversion
        const result = Boolean(value) && stringValue !== '0' && stringValue !== 'false';
        this.log.info(`[DatapointController] Fallback boolean conversion: "${value}" → ${result}`);
        return result;
    }

    /**
     * Intelligent number conversion supporting text and multilingual input
     * @param {*} value
     * @param {Object} customConfig
     * @returns {number}
     */
    convertToNumber(value, customConfig) {
        if (typeof value === 'number') {
            this.log.debug(`[DatapointController] Number value passed through: ${value}`);
            return value;
        }

        const stringValue = String(value).toLowerCase().trim();
        
        // Extract numbers from text (e.g., "20 Grad" → 20, "twenty degrees" → 20)
        const numberMatch = stringValue.match(/(-?\d+\.?\d*)/);
        if (numberMatch) {
            const extractedNumber = parseFloat(numberMatch[1]);
            this.log.info(`[DatapointController] Extracted number from text: "${value}" → ${extractedNumber}`);
            return extractedNumber;
        }

        // Word to number conversion (basic German/English)
        const wordNumbers = {
            // German
            'null': 0, 'eins': 1, 'zwei': 2, 'drei': 3, 'vier': 4, 'fünf': 5,
            'sechs': 6, 'sieben': 7, 'acht': 8, 'neun': 9, 'zehn': 10,
            'zwanzig': 20, 'dreißig': 30, 'vierzig': 40, 'fünfzig': 50,
            'hundert': 100,
            // English
            'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
            'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
            'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
            'hundred': 100
        };

        for (const [word, num] of Object.entries(wordNumbers)) {
            if (stringValue.includes(word)) {
                this.log.info(`[DatapointController] Word to number conversion: "${value}" → ${num} (found word: ${word})`);
                return num;
            }
        }

        // Fallback to standard number conversion
        const result = Number(value);
        if (isNaN(result)) {
            this.log.warn(`[DatapointController] Number conversion failed for "${value}", returning 0`);
            return 0;
        }
        
        this.log.info(`[DatapointController] Standard number conversion: "${value}" → ${result}`);
        return result;
    }

    /**
     * Intelligent string conversion with custom processing
     * @param {*} value
     * @param {Object} customConfig
     * @returns {string}
     */
    convertToString(value, customConfig) {
        const result = String(value);
        this.log.debug(`[DatapointController] String conversion: "${value}" → "${result}"`);
        return result;
    }

    /**
     * Set allowed datapoints for automatic changes
     * @param {Set} allowedDatapoints
     */
    setAllowedDatapoints(allowedDatapoints) {
        this.allowedDatapoints = allowedDatapoints;
        this.log.debug(`[DatapointController] Updated allowed datapoints: ${allowedDatapoints.size} datapoints`);
    }
}

module.exports = DatapointController;
