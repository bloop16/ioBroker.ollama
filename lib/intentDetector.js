"use strict";

/**
 * Intent Detection for multilingual datapoint control
 * Uses ioBroker's built-in translation system
 */
class IntentDetector {
  /**
   * Create a new IntentDetector instance
   *
   * @param {object} log - Logger instance
   * @param {Function} translateFn - Translation function
   */
  constructor(log = console, translateFn = (key) => key) {
    this.log = log;
    this.translate = translateFn;

    // Multilingual control keywords and patterns
    this.controlPatterns = {
      de: {
        keywords: [
          "einschalten",
          "ausschalten",
          "setzen",
          "ändern",
          "schalten",
          "umschalten",
          "anpassen",
          "stellen",
          "machen",
          "aktivieren",
          "deaktivieren",
          "ist",
          "ankommen",
          "verlassen",
          "ein",
          "aus",
          "an",
        ],
        patterns: [
          /schalte?\s+(.+?)\s+(ein|aus|an)/i,
          /mache?\s+(.+?)\s+(an|aus)/i,
          /(.+?)\s+(einschalten|ausschalten)/i,
          /(aktiviere|deaktiviere)\s+(.+)/i,
          /setze?\s+(.+?)\s+auf\s+(.+)/i,
          /stelle?\s+(.+?)\s+auf\s+(.+)/i,
          /(.+?)\s+auf\s+(\d+(?:[.,]\d+)?)\s*(?:°|grad|prozent|%)?/i,
          /(\w+)\s+ist\s+(?:jetzt\s+)?(da|zuhause|angekommen|anwesend|verfügbar)/i,
          /(\w+)\s+ist\s+(?:jetzt\s+)?(weg|nicht\s+da|abwesend|nicht\s+zuhause)/i,
          /(\w+)\s+(?:ist\s+)?(?:jetzt\s+)?(ankommen|verlassen|betreten|gehen)/i,
          /setze\s+(.+?)\s+(status|zustand)\s+auf\s+(.+)/i,
        ],
      },
      en: {
        keywords: [
          "turn",
          "set",
          "change",
          "switch",
          "toggle",
          "adjust",
          "activate",
          "deactivate",
          "make",
          "enable",
          "disable",
          "is",
          "arrived",
          "left",
          "on",
          "off",
        ],
        patterns: [
          /turn\s+(.+?)\s+(on|off)/i,
          /switch\s+(.+?)\s+(on|off)/i,
          /make\s+(.+?)\s+(on|off)/i,
          /(activate|deactivate)\s+(.+)/i,
          /toggle\s+(.+)/i,
          /set\s+(.+?)\s+to\s+(.+)/i,
          /set\s+(.+?)\s+to\s+(\d+(?:\.\d+)?)\s*(?:degrees?|°|percent|%)?/i,
          /(.+?)\s+is\s+(home|here|present|available|arrived)/i,
          /(.+?)\s+is\s+(away|not\s+home|absent|gone|left)/i,
          /(.+?)\s+(arrived|left|entered|departed)/i,
          /set\s+(.+?)\s+(status|state)\s+to\s+(.+)/i,
        ],
      },
    };

    this.actionTypes = {
      SET: "set",
      TOGGLE: "toggle",
      ON: "on",
      OFF: "off",
      INCREASE: "increase",
      DECREASE: "decrease",
    };

    this.log.info(
      this.translate("general_initialized").replace(
        "{{component}}",
        "IntentDetector",
      ),
    );
  }

  /**
   * Detect control intent from user input text
   *
   * @param {string} text - User input text to analyze
   * @returns {object} Intent detection result with isControl, target, action, etc.
   */
  detectControlIntent(text) {
    const lowerText = text.toLowerCase().trim();
    let bestMatch = null;
    let confidence = 0;

    const detectedLanguage = this.detectLanguage(text);
    const languagesToCheck = [
      detectedLanguage,
      ...Object.keys(this.controlPatterns),
    ].filter((lang, index, self) => self.indexOf(lang) === index);

    for (const lang of languagesToCheck) {
      const config = this.controlPatterns[lang];
      if (!config) {
        continue;
      }

      const match = this._analyzeLanguage(lowerText, config, lang);
      if (match && match.confidence > confidence) {
        bestMatch = match;
        confidence = match.confidence;
      }
    }

    if (bestMatch && confidence > 0.6) {
      this.log.debug(this.translate("intent_control_detected"));
      return {
        isControl: true,
        language: bestMatch.language,
        action: bestMatch.action,
        target: bestMatch.target,
        value: bestMatch.value,
        confidence: confidence,
        originalText: text,
      };
    }

    this.log.debug(this.translate("intent_no_intent"));
    return {
      isControl: false,
      confidence: 0,
      originalText: text,
    };
  }

  /**
   * Detect the language of input text
   *
   * @param {string} text - Input text to analyze
   * @returns {string} Detected language code ('de', 'en', etc.)
   */
  detectLanguage(text) {
    const lowerText = text.toLowerCase();
    const germanIndicators = [
      "ist",
      "und",
      "der",
      "die",
      "das",
      "ein",
      "eine",
      "auf",
      "mit",
      "von",
      "zu",
      "in",
      "an",
      "für",
      "setze",
      "schalte",
    ];
    const englishIndicators = [
      "is",
      "and",
      "the",
      "a",
      "an",
      "to",
      "with",
      "of",
      "in",
      "on",
      "at",
      "for",
      "set",
      "turn",
    ];

    let germanScore = 0;
    let englishScore = 0;

    germanIndicators.forEach((word) => {
      if (lowerText.includes(word)) {
        germanScore++;
      }
    });

    englishIndicators.forEach((word) => {
      if (lowerText.includes(word)) {
        englishScore++;
      }
    });

    if (germanScore > englishScore) {
      return "de";
    } else if (englishScore > 0) {
      return "en";
    }

    return "en";
  }

  /**
   * Analyze text for language-specific patterns
   *
   * @param {string} text - Text to analyze
   * @param {object} config - Language configuration
   * @param {string} lang - Language code
   * @returns {object|null} Analysis result or null
   */
  _analyzeLanguage(text, config, lang) {
    let bestMatch = null;
    let maxConfidence = 0;

    const keywordCount = config.keywords.filter((keyword) =>
      text.includes(keyword),
    ).length;

    if (keywordCount === 0) {
      return null;
    }

    for (const pattern of config.patterns) {
      const match = text.match(pattern);
      if (match) {
        const result = this._extractActionFromPattern(match, pattern, lang);
        if (result && result.confidence > maxConfidence) {
          bestMatch = result;
          maxConfidence = result.confidence;
        }
      }
    }

    if (!bestMatch && keywordCount > 0) {
      bestMatch = {
        language: lang,
        action: this._inferActionFromKeywords(text, config.keywords),
        target: this._extractTarget(text, config.keywords),
        value: null,
        confidence: 0.7,
      };
    }

    return bestMatch;
  }

  /**
   * Extract action from pattern match
   *
   * @param {Array} match - Regex match result
   * @param {RegExp} pattern - The pattern that matched
   * @param {string} lang - Language code
   * @returns {string} Detected action
   */
  _extractActionFromPattern(match, pattern, lang) {
    const patternStr = pattern.toString();

    // Handle numeric value patterns
    if (patternStr.includes("\\d+")) {
      const value = parseFloat(match[2] || match[3]);
      return {
        language: lang,
        action: this.actionTypes.SET,
        target: (match[1] || match[2])?.trim(),
        value: value,
        confidence: 0.95,
      };
    }

    // Handle on/off patterns for German (ein/aus/an)
    if (
      patternStr.includes("(ein|aus|an)") ||
      patternStr.includes("(on|off)")
    ) {
      const actionPart = match[2] || match[3];
      const isOn =
        actionPart &&
        (actionPart.includes("on") ||
          actionPart.includes("ein") ||
          actionPart.includes("an"));
      return {
        language: lang,
        action: isOn ? this.actionTypes.ON : this.actionTypes.OFF,
        target: match[1]?.trim(),
        value: null,
        confidence: 0.9,
      };
    }

    // Handle 'to' patterns (set X to Y)
    if (
      patternStr.includes("to\\s+(.+)") ||
      patternStr.includes("auf\\s+(.+)")
    ) {
      let value = match[2]?.trim();
      let target = match[1]?.trim();

      if (value) {
        const numMatch = value.match(/(\d+(?:[.,]\d+)?)/);
        if (numMatch) {
          value = parseFloat(numMatch[1].replace(",", "."));
        }
      }

      return {
        language: lang,
        action: this.actionTypes.SET,
        target: target,
        value: value,
        confidence: 0.95,
      };
    }

    // Handle presence patterns
    if (
      patternStr.includes("(da|zuhause|angekommen|anwesend|verfügbar)") ||
      patternStr.includes("(home|here|present|available|arrived)")
    ) {
      return {
        language: lang,
        action: this.actionTypes.SET,
        target: match[1]?.trim(),
        value: "home",
        confidence: 0.85,
      };
    }

    if (
      patternStr.includes("(weg|nicht\\s+da|abwesend|nicht\\s+zuhause)") ||
      patternStr.includes("(away|not\\s+home|absent|gone|left)")
    ) {
      return {
        language: lang,
        action: this.actionTypes.SET,
        target: match[1]?.trim(),
        value: "away",
        confidence: 0.85,
      };
    }

    // Default fallback
    return {
      language: lang,
      action: this.actionTypes.SET,
      target: match[1]?.trim() || match[2]?.trim(),
      value: match[3]?.trim() || match[2]?.trim() || null,
      confidence: 0.8,
    };
  }

  /**
   * Infer action from keywords in text
   *
   * @param {string} text - Text to analyze
   * @param {Array} _keywords - Keywords array (unused)
   * @returns {string} Inferred action type
   */
  _inferActionFromKeywords(text, _keywords) {
    if (
      text.includes("on") ||
      text.includes("ein") ||
      text.includes("an") ||
      text.includes("activate") ||
      text.includes("aktiviere")
    ) {
      return this.actionTypes.ON;
    }

    if (
      text.includes("off") ||
      text.includes("aus") ||
      text.includes("deactivate") ||
      text.includes("deaktiviere")
    ) {
      return this.actionTypes.OFF;
    }

    if (
      text.includes("toggle") ||
      text.includes("umschalten") ||
      text.includes("schalten")
    ) {
      return this.actionTypes.TOGGLE;
    }

    return this.actionTypes.SET;
  }

  /**
   * Extract target from text using keywords
   *
   * @param {string} text - Text to analyze
   * @param {Array} keywords - Keywords array
   * @returns {string|null} Extracted target or null
   */
  _extractTarget(text, keywords) {
    let cleanText = text;

    keywords.forEach((keyword) => {
      cleanText = cleanText.replace(new RegExp(`\\b${keyword}\\b`, "gi"), "");
    });

    const commonWords = [
      "the",
      "a",
      "an",
      "to",
      "on",
      "off",
      "at",
      "in",
      "with",
      "der",
      "die",
      "das",
      "ein",
      "eine",
      "auf",
      "an",
      "aus",
      "zu",
    ];
    commonWords.forEach((word) => {
      cleanText = cleanText.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
    });

    return cleanText.trim().replace(/\s+/g, " ");
  }

  /**
   * Check if text indicates a scene action
   *
   * @param {string} text - Input text to check
   * @returns {boolean} True if text indicates scene action
   */
  isSceneAction(text) {
    const sceneIndicators = [
      "alle",
      "mehrere",
      "scene",
      "szene",
      "gruppe",
      "bereich",
      "all",
      "multiple",
      "scene",
      "group",
      "room",
      "area",
      "and",
      "und",
      "with",
      "mit",
    ];

    const lowerText = text.toLowerCase();
    const hasSceneIndicator = sceneIndicators.some((indicator) =>
      lowerText.includes(indicator),
    );

    if (hasSceneIndicator) {
      this.log.debug(this.translate("intent_scene_detected"));
    }

    return hasSceneIndicator;
  }

  /**
   * Extract scene targets from text
   *
   * @param {string} text - Input text to analyze
   * @returns {Array} Array of extracted targets
   */
  extractSceneTargets(text) {
    const separators = [" and ", " und ", " with ", " mit ", ",", ";"];
    let targets = [text];

    separators.forEach((sep) => {
      const newTargets = [];
      targets.forEach((target) => {
        if (target.includes(sep)) {
          newTargets.push(...target.split(sep).map((t) => t.trim()));
        } else {
          newTargets.push(target);
        }
      });
      targets = newTargets;
    });

    return targets.filter((target) => target.length > 0);
  }

  /**
   * Check if confidence level is sufficient for action
   *
   * @param {number} confidence - Confidence score to evaluate
   * @returns {boolean} True if confidence is sufficient
   */
  isSufficientConfidence(confidence) {
    const threshold = 0.6;
    if (confidence < threshold) {
      this.log.warn(this.translate("intent_confidence_low"));
      return false;
    }
    return true;
  }
}

module.exports = IntentDetector;
