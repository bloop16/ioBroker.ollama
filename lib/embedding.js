// embedding.js
// Handles embedding generation and Qdrant storage for datapoints with embedding enabled

const { QdrantClient } = require("@qdrant/qdrant-js");

/**
 * Generate embedding for a datapoint and store in Qdrant
 * @param {object} options - { value, id, config, qdrantConfig, logger }
 * @returns {Promise<void>}
 */
async function handleEmbedding({ value, id, config, qdrantConfig, logger }) {
    // Support both 'embeddingEnabled' and legacy 'enabled' flag
    const embeddingFlag = config.embeddingEnabled === true || config.enabled === true;
    if (!embeddingFlag) return;
    if (!qdrantConfig || !qdrantConfig.enabled) return;
    logger.debug(`[EMBEDDING] Triggered for datapoint: ${id}, value: ${JSON.stringify(value)}, custom config: ${JSON.stringify(config)}`);
    try {
        // Example: Use Ollama API for embedding (replace with actual embedding logic)
        // const embedding = await getEmbeddingFromOllama(value);
        const embedding = Array(768).fill(0); // Dummy embedding, replace with real
        const qdrant = new QdrantClient({ url: `http://${qdrantConfig.ip}:${qdrantConfig.port}` });
        await qdrant.upsert("ollama_embeddings", {
            points: [{
                id,
                vector: embedding,
                payload: {
                    value,
                    ...config
                }
            }]
        });
        logger.debug(`[EMBEDDING] Embedding for ${id} stored in Qdrant.`);
    } catch (err) {
        logger.debug(`[EMBEDDING] Failed to store embedding for ${id}: ${err}`);
    }
}

module.exports = { handleEmbedding };
