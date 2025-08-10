"use strict";

const { QdrantClient } = require("@qdrant/qdrant-js");
const axios = require("axios");

class QdrantHelper {
    /**
     * Checks the availability of Qdrant server
     * @param {string} ip
     * @param {number|string} port
     * @param {{info: Function, error: Function, debug?: Function}} log
     * @returns {Promise<boolean>}
     * @throws Will throw an error if the server is not reachable
     */
    static async checkAvailability(ip, port, log) {
        const url = `http://${ip}:${port}`;
        const client = new QdrantClient({ url });
        try {
            await client.getCollections();
            if (log.debug) {
                log.debug(`[VectorDB] Qdrant server available at ${url}`);
            }
            return true;
        } catch (err) {
            log.error(`[VectorDB] Error connecting to Qdrant: ${err.message}`);
            throw err;
        }
    }

    static async processEmbeddingDatapoint(id, state, config, log, processedStates, getForeignObjectAsync) {
        if (!config.useVectorDb) return;
        
        try {
            const obj = await getForeignObjectAsync(id);
            if (!obj?.common?.custom) return;
            
            // Find adapter's namespace in custom config
            let customConfig = null;
            for (const namespace in obj.common.custom) {
                if (namespace.startsWith('ollama.')) {
                    customConfig = obj.common.custom[namespace];
                    break;
                }
            }
            
            if (!customConfig?.enabled) return;
            
            // Simple deduplication
            const stateKey = `${id}_${state.val}_${Math.floor(state.ts / 60000)}`;
            if (processedStates.has(stateKey)) return;
            
            processedStates.add(stateKey);
            
            // Cleanup old entries periodically
            if (processedStates.size > 500) {
                const entries = Array.from(processedStates);
                processedStates.clear();
                entries.slice(-250).forEach(entry => processedStates.add(entry));
            }
            
            const openWebUIUrl = `http://${config.openWebUIIp}:${config.openWebUIPort}`;
            const qdrantUrl = `http://${config.vectorDbIp}:${config.vectorDbPort}`;
            
            await this.processEmbeddingEnabledDatapoint(
                id, state, customConfig, openWebUIUrl, qdrantUrl, log,
                config.embeddingModel || 'nomic-embed-text', config.openWebUIApiKey || ''
            );
            
            // Periodic cleanup (5% chance)
            if (Math.random() < 0.05) {
                await this.cleanupDuplicateEntries(id, qdrantUrl, 'iobroker_datapoints', log);
            }
            
        } catch (error) {
            log.error(`[VectorDB] Error processing embedding for ${id}: ${error.message}`);
        }
    }

    static async processEmbeddingEnabledDatapoint(id, state, customConfig, openWebUIUrl, qdrantUrl, log, embeddingModel = 'nomic-embed-text', apiKey = '') {
        try {
            const formattedData = this.formatDataForVectorDB(id, state, customConfig);
            const embedding = await this.generateEmbedding(formattedData.formattedText, openWebUIUrl, log, embeddingModel, apiKey);
            const dataWithEmbedding = { ...formattedData, embedding };
            await this.sendToQdrant(dataWithEmbedding, qdrantUrl, 'iobroker_datapoints', log);
        } catch (error) {
            log.error(`[VectorDB] Error processing datapoint ${id}: ${error.message}`);
            throw error;
        }
    }

    static formatDataForVectorDB(id, state, customConfig) {
        const timestamp = new Date().toISOString();
        const baseData = {
            id, timestamp, value: state.val,
            description: customConfig.description || '',
            location: customConfig.location || '',
            dataType: customConfig.dataType || 'text',
            allowAutoChange: customConfig.allowAutoChange || false,
            booleanTrueValue: customConfig.booleanTrueValue,
            booleanFalseValue: customConfig.booleanFalseValue
        };

        let formattedText = '';
        const desc = baseData.description;
        const loc = baseData.location ? ` (${baseData.location})` : '';
        
        switch (customConfig.dataType) {
            case 'boolean':
                const displayValue = state.val 
                    ? (customConfig.booleanTrueValue || 'true')
                    : (customConfig.booleanFalseValue || 'false');
                formattedText = `${desc} ${displayValue}${loc}`;
                break;

            case 'number':
                const units = customConfig.units || '';
                formattedText = `${desc}: ${state.val}${units}${loc}`;
                break;

            default:
                formattedText = `${desc}: ${state.val}${loc}`;
                if (customConfig.additionalText) {
                    formattedText += ` - ${customConfig.additionalText}`;
                }
                break;
        }

        return { ...baseData, formattedText: formattedText.trim() };
    }

    static async generateEmbedding(text, openWebUIUrl, log, embeddingModel = 'nomic-embed-text', apiKey = '') {
        try {
            const headers = this._buildHeaders(apiKey);
            
            const response = await axios.post(`${openWebUIUrl}/ollama/api/embed`, {
                model: embeddingModel,
                input: text
            }, { headers, timeout: 30000 });
            
            if (!response.data.embeddings?.[0]) {
                throw new Error('No embeddings returned from API');
            }
            
            return response.data.embeddings[0];
        } catch (error) {
            log.error(`[VectorDB] Error generating embedding: ${error.message}`);
            throw error;
        }
    }

    static _buildHeaders(apiKey = '') {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        return headers;
    }

    static async sendToQdrant(data, qdrantUrl, collectionName = 'iobroker_datapoints', log) {
        const client = new QdrantClient({ url: qdrantUrl });
        
        try {
            await this.ensureCollection(client, collectionName, log);
            const pointId = this.generatePointId(data.id, data.timestamp);
            
            const point = {
                id: pointId,
                vector: data.embedding,
                payload: {
                    datapoint_id: data.id,      // GitHub Version: datapoint_id
                    timestamp: data.timestamp,
                    value: data.value,
                    description: data.description,
                    location: data.location,
                    dataType: data.dataType,
                    formatted_text: data.formattedText,  // GitHub Version: formatted_text
                    allowAutoChange: data.allowAutoChange || false,
                    booleanTrueValue: data.booleanTrueValue,
                    booleanFalseValue: data.booleanFalseValue
                }
            };
            
            await client.upsert(collectionName, {
                wait: true,
                points: [point]
            });
        } catch (error) {
            log.error(`[VectorDB] Error storing data in Qdrant: ${error.message}`);
            throw error;
        }
    }

    static async ensureCollection(client, collectionName, log) {
        try {
            const collections = await client.getCollections();
            const exists = collections.collections.some(c => c.name === collectionName);
            
            if (!exists) {
                await client.createCollection(collectionName, {
                    vectors: { size: 768, distance: "Cosine" }
                });
                log.info(`[VectorDB] Collection ${collectionName} created`);
            }
        } catch (error) {
            log.error(`[VectorDB] Error ensuring collection: ${error.message}`);
            throw error;
        }
    }

    static generatePointId(datapointId, timestamp) {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(`${datapointId}_${timestamp}`).digest('hex');
    }

    static async cleanupDuplicateEntries(datapointId, qdrantUrl, collectionName = 'iobroker_datapoints', log) {
        const client = new QdrantClient({ url: qdrantUrl });
        
        try {
            const searchResult = await client.scroll(collectionName, {
                filter: {
                    must: [{ key: "datapoint_id", match: { value: datapointId } }]
                },
                limit: 1000
            });
            
            if (searchResult.points.length <= 1) return;
            
            // Sort by timestamp (newest first) and keep only the latest
            const sortedPoints = searchResult.points.sort((a, b) => {
                const aTime = a.payload?.timestamp ? new Date(String(a.payload.timestamp)).getTime() : 0;
                const bTime = b.payload?.timestamp ? new Date(String(b.payload.timestamp)).getTime() : 0;
                return bTime - aTime;
            });
            
            const pointsToDelete = sortedPoints.slice(1);
            
            if (pointsToDelete.length > 0) {
                const idsToDelete = pointsToDelete.map(p => p.id);
                await client.delete(collectionName, {
                    wait: true,
                    points: idsToDelete
                });
                log.info(`[VectorDB] Deleted ${pointsToDelete.length} duplicate entries for ${datapointId}`);
            }
        } catch (error) {
            log.error(`[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`);
        }
    }

    static async cleanupAllDuplicates(enabledDatapoints, qdrantUrl, collectionName = 'iobroker_datapoints', log) {
        if (!enabledDatapoints?.size) {
            log.warn('[VectorDB] No enabled datapoints found for cleanup');
            return;
        }

        let totalCleaned = 0;
        log.info('[VectorDB] Starting cleanup of duplicate entries for all datapoints...');
        
        // Use cleanupDuplicateEntries for consistent logic
        for (const datapointId of enabledDatapoints) {
            try {
                await this.cleanupDuplicateEntries(datapointId, qdrantUrl, collectionName, log);
                totalCleaned++;
            } catch (error) {
                log.error(`[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`);
            }
        }
        
        log.info(`[VectorDB] Cleanup completed for ${totalCleaned} datapoints`);
    }

    /**
     * Check for existing objects with enabled embedding on startup
     */
    static async checkExistingEmbeddingEnabled(adapter) {
        adapter.log.debug("Checking for existing objects with enabled features...");
        
        try {
            const objects = await adapter.getObjectViewAsync('system', 'custom', {});
            
            if (objects?.rows) {
                for (const row of objects.rows) {
                    const id = row.id;
                    const customConfig = row.value?.[adapter.namespace];
                    
                    if (customConfig) {
                        const features = [];
                        
                        // Check for embedding enabled
                        if (customConfig.enabled === true) {
                            adapter._enabledDatapoints.add(id);
                            adapter.subscribeForeignStates(id);
                            features.push("Vector Database");
                        }
                        
                        // Check for auto-change enabled
                        if (customConfig.allowAutoChange === true) {
                            adapter._enabledDatapoints.add(id);
                            features.push("Function Calling");
                        }
                        
                        if (features.length > 0) {
                            adapter.log.info(`[Config] Datapoint ${id} configured for: ${features.join(", ")}`);
                        }
                    }
                }
            }
        } catch (error) {
            adapter.log.error(`Error checking existing objects: ${error}`);
        }
        
        adapter.log.info(`[AI] Found ${adapter._enabledDatapoints.size} datapoints with AI features enabled`);
    }
}

module.exports = QdrantHelper;
