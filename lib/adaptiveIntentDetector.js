"use strict";

const IntentDetector = require("./intentDetector");
const LLMIntentDetector = require("./llmIntentDetector");

/**
 * Adaptive Intent Detection - switches between pattern-based and LLM-based detection
 * Supports ioBroker i18n system
 */
class AdaptiveIntentDetector {
    constructor(ollamaClient = null, log = console, translateFn = (key) => key) {
        this.log = log;
        this.translate = translateFn;
        
        // Initialize both detectors with i18n support
        this.patternDetector = new IntentDetector(log, translateFn);
        this.llmDetector = ollamaClient ? new LLMIntentDetector(ollamaClient, log, translateFn) : null;
        
        // Configuration
        this.config = {
            useLLM: !!ollamaClient,
            fallbackToPattern: true,
            llmConfidenceThreshold: 0.7,
            patternConfidenceThreshold: 0.6  // Lowered from 0.8 to 0.6 for better pattern acceptance
        };
        
        this.log.info(this.translate('general_initialized').replace('{{component}}', 'AdaptiveIntentDetector'));
    }

    /**
     * Detect control intent using adaptive approach
     * @param {string} text - User input
     * @param {Array} availableDatapoints - Optional context for better matching
     * @returns {Promise<Object>} Intent analysis result
     */
    async detectControlIntent(text, availableDatapoints = []) {
        try {
            let result = null;

            // Try LLM detection first if available
            if (this.config.useLLM && this.llmDetector) {
                try {
                    this.log.debug(`[AdaptiveIntentDetector] Trying LLM detection for: "${text}"`);
                    result = await this.llmDetector.detectControlIntentWithContext(text, availableDatapoints);
                    
                    if (result && result.confidence >= this.config.llmConfidenceThreshold) {
                        this.log.debug(`[AdaptiveIntentDetector] LLM detection successful: confidence ${result.confidence}`);
                        result.detectionMethod = 'LLM';
                        return result;
                    } else {
                        this.log.debug(`[AdaptiveIntentDetector] LLM confidence too low: ${result?.confidence || 0}`);
                    }
                } catch (llmError) {
                    this.log.warn(`[AdaptiveIntentDetector] LLM detection failed: ${llmError.message}`);
                }
            }

            // Fallback to pattern detection
            if (this.config.fallbackToPattern) {
                this.log.debug(`[AdaptiveIntentDetector] Trying pattern detection for: "${text}"`);
                result = this.patternDetector.detectControlIntent(text);
                
                if (result && result.confidence >= this.config.patternConfidenceThreshold) {
                    this.log.debug(`[AdaptiveIntentDetector] Pattern detection successful: confidence ${result.confidence}`);
                    result.detectionMethod = 'Pattern';
                    return result;
                } else {
                    this.log.debug(`[AdaptiveIntentDetector] Pattern confidence too low: ${result?.confidence || 0}`);
                }
            }

            // No detection method succeeded
            this.log.debug(`[AdaptiveIntentDetector] No detection method succeeded for: "${text}"`);
            return {
                isControl: false,
                confidence: 0,
                originalText: text,
                detectionMethod: 'None'
            };

        } catch (error) {
            this.log.error(`[AdaptiveIntentDetector] Detection error: ${error.message}`);
            return {
                isControl: false,
                confidence: 0,
                originalText: text,
                error: error.message,
                detectionMethod: 'Error'
            };
        }
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.log.info(`[AdaptiveIntentDetector] Configuration updated: ${JSON.stringify(this.config)}`);
    }

    /**
     * Enable/disable LLM detection
     * @param {Object} ollamaClient - Ollama client instance
     */
    setOllamaClient(ollamaClient) {
        if (ollamaClient) {
            this.llmDetector = new LLMIntentDetector(ollamaClient, this.log);
            this.config.useLLM = true;
            this.log.info(`[AdaptiveIntentDetector] LLM detection enabled`);
        } else {
            this.llmDetector = null;
            this.config.useLLM = false;
            this.log.info(`[AdaptiveIntentDetector] LLM detection disabled`);
        }
    }

    /**
     * Get detection statistics
     * @returns {Object} Statistics about detection methods
     */
    getStats() {
        return {
            llmAvailable: !!this.llmDetector,
            patternAvailable: !!this.patternDetector,
            config: this.config
        };
    }

    // Delegate other methods to pattern detector for compatibility
    isSceneAction(text) {
        return this.patternDetector.isSceneAction(text);
    }

    extractSceneTargets(text) {
        return this.patternDetector.extractSceneTargets(text);
    }
}

module.exports = AdaptiveIntentDetector;
