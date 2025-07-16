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
     * Get function definitions for AI model
     * @returns {Array<Object>}
     */
    getFunctionDefinitions() {
        return this.availableFunctions;
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

        // Check if datapoint is allowed
        if (!this.allowedDatapoints.has(datapointId)) {
            throw new Error(`Datapoint ${datapointId} is not allowed for automatic changes. Enable it in custom config.`);
        }

        // Validate datapoint exists and is writable
        const obj = await this.adapter.getForeignObjectAsync(datapointId);
        if (!obj) {
            throw new Error(`Datapoint ${datapointId} not found`);
        }

        // Check if writable (using bracket notation for type safety)
        if (obj.common && obj.common['write'] === false) {
            throw new Error(`Datapoint ${datapointId} is not writable`);
        }

        // Convert value to appropriate type (using bracket notation for type safety)
        const targetType = (obj.common && obj.common['type']) ? obj.common['type'] : 'string';
        const convertedValue = this.convertValue(value, targetType);

        // Set the value
        await this.adapter.setForeignStateAsync(datapointId, convertedValue, false);

        this.log.info(`[DatapointController] Model ${modelId} set ${datapointId} to ${convertedValue}`);

        return {
            success: true,
            datapointId: datapointId,
            value: convertedValue,
            previousValue: null, // Could be enhanced to include previous value
            timestamp: new Date().toISOString(),
            modelId: modelId
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

        // Check if datapoint is allowed
        if (!this.allowedDatapoints.has(datapointId)) {
            throw new Error(`Datapoint ${datapointId} is not allowed for automatic changes`);
        }

        // Get current value
        const currentState = await this.adapter.getForeignStateAsync(datapointId);
        if (!currentState) {
            throw new Error(`Datapoint ${datapointId} not found or no state available`);
        }

        const currentValue = parseFloat(String(currentState.val));
        if (isNaN(currentValue)) {
            throw new Error(`Datapoint ${datapointId} does not contain a numeric value`);
        }

        const newValue = currentValue + amount;
        
        // Set new value
        await this.adapter.setForeignStateAsync(datapointId, newValue, false);

        this.log.info(`[DatapointController] Model ${modelId} incremented ${datapointId} by ${amount} (${currentValue} -> ${newValue})`);

        return {
            success: true,
            datapointId: datapointId,
            previousValue: currentValue,
            increment: amount,
            newValue: newValue,
            timestamp: new Date().toISOString(),
            modelId: modelId
        };
    }

    /**
     * Convert value to appropriate type
     * @param {*} value
     * @param {string} targetType
     * @returns {*}
     */
    convertValue(value, targetType) {
        switch (targetType) {
            case 'boolean':
                if (typeof value === 'boolean') return value;
                if (typeof value === 'string') {
                    return value.toLowerCase() === 'true' || value === '1' || value === 'on';
                }
                return Boolean(value);
            case 'number':
                return Number(value);
            case 'string':
                return String(value);
            default:
                return value;
        }
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
