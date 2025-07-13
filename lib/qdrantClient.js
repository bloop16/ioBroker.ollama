"use strict";

const { QdrantClient } = require("@qdrant/qdrant-js");

class QdrantHelper {
    /**
     * Checks the availability of Qdrant server
     * @param {string} ip
     * @param {number|string} port
     * @param {{info: Function, error: Function}} log - logger with info and error methods
     * @returns {Promise<boolean>}
     * @throws Will throw an error if the server is not reachable
     */
    static async checkAvailability(ip, port, log) {
        const url = `http://${ip}:${port}`;
        log.info(`Checking Vector DB availability via Qdrant client at ${ip}:${port}`);
        const client = new QdrantClient({ url });
        try {
            await client.getCollections();
            log.info('Vector DB is available');
            return true;
        } catch (err) {
            log.error(`Error connecting to Vector DB: ${err}`);
            throw err;
        }
    }

    /**
     * Watch for custom config changes on datapoints and log embeddingEnabled flag
     * @param {object} adapter - The ioBroker adapter instance
     */
    static watchEmbeddingEnabled(adapter) {
        adapter.on('objectChange', (id, obj) => {
            if (obj && obj.native && typeof obj.native.embeddingEnabled === 'boolean') {
                adapter.log.debug(`Embedding enabled for datapoint ${id}: ${obj.native.embeddingEnabled}`);
            }
        });
    }
}

module.exports = QdrantHelper;
