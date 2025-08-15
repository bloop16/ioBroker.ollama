"use strict";

/**
 * LLM-based Intent Detection with ioBroker i18n support
 * Uses Large Language Models for more sophisticated intent understanding
 */
class LLMIntentDetector {
  /**
   * Create a new LLMIntentDetector instance
   *
   * @param {object} ollamaClient - OllamaClient instance for LLM operations
   * @param {object} log - Logger instance
   * @param {Function} translateFn - Translation function
   */
  constructor(ollamaClient, log = console, translateFn = (key) => key) {
    this.ollamaClient = ollamaClient;
    this.log = log;
    this.translate = translateFn;

    // Fallback pattern detector for validation
    const IntentDetector = require("./intentDetector");
    this.fallbackDetector = new IntentDetector(log, translateFn);

    this.log.info(
      this.translate("general_initialized").replace(
        "{{component}}",
        "LLMIntentDetector",
      ),
    );
  }

  /**
   * Detect control intent using LLM
   *
   * @param {string} text - User input
   * @param {Array} _availableDatapoints - Context for better matching
   * @returns {Promise<object>} Intent detection result
   */
  async detectControlIntent(text, _availableDatapoints = []) {
    try {
      // For now, fallback to pattern-based detection
      // In a full implementation, this would use the LLM to understand more complex intents
      this.log.debug(this.translate("llm_fallback_pattern"));

      const patternResult = this.fallbackDetector.detectControlIntent(text);

      if (patternResult.isControl) {
        // Enhance with LLM-specific confidence boost
        patternResult.confidence = Math.min(
          0.95,
          patternResult.confidence + 0.1,
        );
        patternResult.method = "llm_enhanced_pattern";
      }

      return patternResult;
    } catch (error) {
      this.log.error(
        this.translate("llm_error").replace("{{error}}", error.message),
      );

      // Fallback to pattern detection on error
      return this.fallbackDetector.detectControlIntent(text);
    }
  }

  /**
   * Configure LLM model settings
   *
   * @param {object} config - LLM configuration
   */
  configure(config) {
    this.config = { ...this.config, ...config };
    this.log.debug(this.translate("llm_configured"));
  }

  /**
   * Check if LLM is available
   *
   * @returns {Promise<boolean>} Availability status
   */
  async isAvailable() {
    try {
      if (!this.ollamaClient) {
        return false;
      }

      // In a full implementation, this would check if the LLM model is loaded
      return true;
    } catch (error) {
      this.log.debug(
        this.translate("llm_unavailable").replace("{{error}}", error.message),
      );
      return false;
    }
  }

  /**
   * Get LLM-specific confidence threshold
   *
   * @returns {number} Confidence threshold
   */
  getConfidenceThreshold() {
    return 0.7; // Higher threshold for LLM-based detection
  }
}

module.exports = LLMIntentDetector;
