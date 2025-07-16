"use strict";

const { QdrantClient } = require("@qdrant/qdrant-js");

class QdrantHelper {
    /**
     * Checks the availability of Qdrant server
     * @param {string} ip
     * @param {number|string} port
     * @param {{info: Function, error: Function}} log
     * @returns {Promise<boolean>}
     * @throws Will throw an error if the server is not reachable
     */
    static async checkAvailability(ip, port, log) {
        const url = `http://${ip}:${port}`;
        // Check Qdrant availability silently
        const client = new QdrantClient({ url });
        try {
            await client.getCollections();
                // Qdrant is available - no logging needed for routine checks
            return true;
        } catch (err) {
            log.error(`[VectorDB] Error connecting to Qdrant: ${err}`);
            throw err;
        }
    }

    /**
     * Process embedding enabled datapoint for vector database
     * @param {string} id
     * @param {object} state
     * @param {object} customConfig
     * @param {string} ollamaUrl
     * @param {string} qdrantUrl
     * @param {object} log
     * @param {string} embeddingModel
     */
    static async processEmbeddingEnabledDatapoint(id, state, customConfig, ollamaUrl, qdrantUrl, log, embeddingModel = 'nomic-embed-text') {
        try {
            // Format the data based on dataType
            const formattedData = this.formatDataForVectorDB(id, state, customConfig);
            
            // Processing datapoint for vector storage
            
            // Generate embedding using Ollama's embedding model
            const embedding = await this.generateEmbedding(formattedData.formattedText, ollamaUrl, log, embeddingModel);
            formattedData.embedding = embedding;
            
            // Store in Qdrant
            await this.sendToQdrant(formattedData, qdrantUrl, 'iobroker_datapoints', log);
            
            // Embedding stored successfully
            
        } catch (error) {
            log.error(`[VectorDB] Error processing datapoint ${id}: ${error}`);
        }
    }

    /**
     * Format datapoint data based on its type for vector database
     * @param {string} id
     * @param {object} state
     * @param {object} customConfig
     * @returns {object}
     */
    static formatDataForVectorDB(id, state, customConfig) {
        const timestamp = new Date().toISOString();
        const baseData = {
            id: id,
            timestamp: timestamp,
            value: state.val,
            description: customConfig.description || '',
            location: customConfig.location || '',
            dataType: customConfig.dataType || 'text'
        };

        let formattedText = '';
        
        switch (customConfig.dataType) {
            case 'boolean':
                const boolValue = state.val;
                const displayValue = boolValue 
                    ? (customConfig.booleanTrueValue || 'true')
                    : (customConfig.booleanFalseValue || 'false');
                
                formattedText = `${baseData.description} ${displayValue}`;
                if (baseData.location) {
                    formattedText += ` (${baseData.location})`;
                }
                break;

            case 'number':
                const numValue = state.val;
                const units = customConfig.units || '';
                
                formattedText = `${baseData.description}: ${numValue}${units}`;
                if (baseData.location) {
                    formattedText += ` (${baseData.location})`;
                }
                break;

            case 'text':
            default:
                formattedText = `${baseData.description}: ${state.val}`;
                if (baseData.location) {
                    formattedText += ` (${baseData.location})`;
                }
                if (customConfig.additionalText) {
                    formattedText += ` - ${customConfig.additionalText}`;
                }
                break;
        }

        return {
            ...baseData,
            formattedText: formattedText.trim(),
            embedding: null // Will be filled by embedding model
        };
    }

    /**
     * Generate embedding using Ollama's embedding model
     * @param {string} text
     * @param {string} ollamaUrl
     * @param {object} log
     * @param {string} embeddingModel
     * @returns {Promise<number[]>}
     */
    static async generateEmbedding(text, ollamaUrl, log, embeddingModel = 'nomic-embed-text') {
        const axios = require('axios');
        try {
            const response = await axios.post(`${ollamaUrl}/api/embed`, {
                model: embeddingModel,
                input: text
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
            
            return response.data.embeddings[0];
        } catch (error) {
            log.error(`[VectorDB] Error generating embedding: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send formatted data to Qdrant vector database
     * @param {object} data
     * @param {string} qdrantUrl
     * @param {string} collectionName
     * @param {object} log
     */
    static async sendToQdrant(data, qdrantUrl, collectionName = 'iobroker_datapoints', log) {
        const client = new QdrantClient({ url: qdrantUrl });
        
        try {
            // Check if collection exists, create if not
            const collections = await client.getCollections();
            const collectionExists = collections.collections.some(c => c.name === collectionName);
            
            if (!collectionExists) {
                await client.createCollection(collectionName, {
                    vectors: {
                        size: 768,
                        distance: 'Cosine'
                    }
                });
                // Collection created successfully - no logging needed
            }
            
            // Store the point in Qdrant
            await client.upsert(collectionName, {
                wait: true,
                points: [{
                    id: this.generatePointId(data.id, data.timestamp),
                    vector: data.embedding,
                    payload: {
                        datapoint_id: data.id,
                        timestamp: data.timestamp,
                        value: data.value,
                        description: data.description,
                        location: data.location,
                        dataType: data.dataType,
                        formatted_text: data.formattedText
                    }
                }]
            });
            
            // Embedding stored successfully
        } catch (error) {
            log.error(`[VectorDB] Error storing data in Qdrant: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate a unique point ID for Qdrant
     * @param {string} datapointId
     * @param {string} timestamp
     */
    static generatePointId(datapointId, timestamp) {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(`${datapointId}_${timestamp}`).digest('hex');
    }

    /**
     * Search for similar datapoints in Qdrant
     * @param {string} queryText
     * @param {string} ollamaUrl
     * @param {string} qdrantUrl
     * @param {string} collectionName
     * @param {object} log
     * @param {number} limit
     * @param {string} embeddingModel
     * @returns {Promise<Array>}
     */
    static async searchSimilar(queryText, ollamaUrl, qdrantUrl, collectionName = 'iobroker_datapoints', log, limit = 10, embeddingModel = 'nomic-embed-text') {
        try {
            // Generate embedding for query
            const queryEmbedding = await this.generateEmbedding(queryText, ollamaUrl, log, embeddingModel);
            
            // Search in Qdrant
            const client = new QdrantClient({ url: qdrantUrl });
            const searchResults = await client.search(collectionName, {
                vector: queryEmbedding,
                limit: limit,
                with_payload: true
            });
            
            // Transform Qdrant results to expected format
            const formattedResults = searchResults.map(result => ({
                id: result.id,
                score: result.score,
                datapoint_id: result.payload?.datapoint_id || 'unknown',
                timestamp: result.payload?.timestamp || 'unknown',
                value: result.payload?.value || 'unknown',
                description: result.payload?.description || '',
                location: result.payload?.location || '',
                dataType: result.payload?.dataType || 'unknown',
                formatted_text: result.payload?.formatted_text || 'No formatted text available'
            }));
            
            // Found similar datapoints in vector search
            return formattedResults;
        } catch (error) {
            log.error(`[VectorDB] Error searching in Qdrant: ${error.message}`);
            throw error;
        }
    }

    /**
     * Clean up duplicate entries from Qdrant for a specific datapoint
     * @param {string} datapointId
     * @param {string} qdrantUrl
     * @param {string} collectionName
     * @param {object} log
     */
    static async cleanupDuplicateEntries(datapointId, qdrantUrl, collectionName = 'iobroker_datapoints', log) {
        try {
            const client = new QdrantClient({ url: qdrantUrl });
            
            // Search for all entries for this datapoint
            const searchResults = await client.scroll(collectionName, {
                filter: {
                    must: [
                        { key: 'datapoint_id', match: { value: datapointId } }
                    ]
                },
                limit: 1000,
                with_payload: true
            });
            
            if (searchResults.points.length === 0) {
                return;
            }
            
            // Group by value and timestamp (rounded to nearest minute to catch near-duplicates)
            const groups = {};
            
            for (const point of searchResults.points) {
                if (!point.payload) continue;
                
                const value = point.payload.value;
                const timestamp = new Date(String(point.payload.timestamp));
                const roundedTimestamp = new Date(Math.floor(timestamp.getTime() / 60000) * 60000).toISOString();
                const key = `${value}_${roundedTimestamp}`;
                
                if (!groups[key]) {
                    groups[key] = [];
                }
                groups[key].push(point);
            }
            
            // Keep only the latest entry for each group and delete the rest
            const idsToDelete = [];
            let duplicatesCount = 0;
            
            for (const [key, points] of Object.entries(groups)) {
                if (points.length > 1) {
                    // Sort by timestamp (newest first)
                    points.sort((a, b) => {
                        const timeA = new Date(String(a.payload?.timestamp || 0)).getTime();
                        const timeB = new Date(String(b.payload?.timestamp || 0)).getTime();
                        return timeB - timeA;
                    });
                    
                    // Keep the first (newest) entry, delete the rest
                    for (let i = 1; i < points.length; i++) {
                        idsToDelete.push(points[i].id);
                        duplicatesCount++;
                    }
                }
            }
            
            // Delete duplicate entries
            if (idsToDelete.length > 0) {
                await client.delete(collectionName, {
                    points: idsToDelete
                });
                // Cleaned up duplicates - no logging needed for routine maintenance
            }
            
        } catch (error) {
            log.error(`[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`);
        }
    }
}

module.exports = QdrantHelper;
