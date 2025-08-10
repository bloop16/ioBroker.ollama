"use strict";

/**
 * Internationalization (i18n) Helper for ioBroker.ollama
 * Provides multi-language support for all components
 */
class I18n {
    constructor(log = console) {
        this.log = log;
        this.currentLanguage = 'en'; // Default language
        this.fallbackLanguage = 'en';
        this.translations = new Map();
        this.supportedLanguages = ['en', 'de']; // Start with English and German
        
        this.loadTranslations();
    }

    /**
     * Load translations from memory (embedded translations)
     */
    loadTranslations() {
        // Embedded translations for core functionality
        const coreTranslations = {
            en: {
                // Intent Detection
                'intent.control_detected': 'Control intent detected',
                'intent.info_detected': 'Information request detected',
                'intent.no_intent': 'No intent recognized',
                'intent.scene_detected': 'Scene action detected',
                'intent.confidence_low': 'Intent confidence too low',
                
                // Datapoint Controller
                'datapoint.set_success': 'Successfully set {{datapoint}} to {{value}}',
                'datapoint.set_failed': 'Failed to set {{datapoint}}: {{error}}',
                'datapoint.not_allowed': 'Datapoint {{datapoint}} not allowed for automatic control',
                'datapoint.type_conversion_failed': 'Type conversion failed for {{value}} to {{type}}',
                'datapoint.boolean_true': 'true',
                'datapoint.boolean_false': 'false',
                'datapoint.invalid_type': 'Invalid data type: {{type}}',
                
                // Learning System
                'learning.action_recorded': 'Recorded action for {{datapoint}}',
                'learning.scene_created': 'Created scene "{{name}}" with {{count}} datapoints',
                'learning.association_learned': 'Learned association between {{primary}} and {{partner}}',
                'learning.data_saved': 'Learning data saved',
                'learning.data_loaded': 'Learning data loaded with {{count}} associations',
                
                // Tool Server
                'server.starting': 'Starting ToolServer...',
                'server.started': 'ToolServer started successfully on port {{port}}',
                'server.failed_start': 'Failed to start ToolServer: {{error}}',
                'server.stopping': 'Stopping ToolServer...',
                'server.stopped': 'ToolServer stopped',
                'server.already_running': 'ToolServer already running',
                'server.chat_processed': 'Chat request processed successfully',
                'server.intent_processed': 'Intent request processed',
                
                // Vector Database / RAG
                'vectordb.connection_ok': 'Vector database connection successful',
                'vectordb.connection_failed': 'Vector database connection failed: {{error}}',
                'vectordb.embedding_generated': 'Embedding generated for {{text}}',
                'vectordb.data_stored': 'Data stored in vector database',
                'vectordb.duplicates_cleaned': 'Cleaned {{count}} duplicate entries',
                'vectordb.search_completed': 'Vector search completed with {{count}} results',
                
                // LLM Integration
                'llm.response_generated': 'LLM response generated',
                'llm.request_failed': 'LLM request failed: {{error}}',
                'llm.model_unavailable': 'LLM model unavailable',
                'llm.intent_analysis_complete': 'LLM intent analysis complete',
                'llm.fallback_parsing': 'Using fallback parsing for LLM response',
                
                // General Messages
                'general.initialized': '{{component}} initialized successfully',
                'general.configuration_updated': 'Configuration updated',
                'general.error_occurred': 'Error occurred: {{error}}',
                'general.operation_complete': 'Operation completed',
                'general.invalid_input': 'Invalid input: {{input}}',
                'general.not_available': '{{feature}} not available',
                
                // Presence/State Keywords
                'presence.home': 'home',
                'presence.present': 'present',
                'presence.available': 'available',
                'presence.here': 'here',
                'presence.arrived': 'arrived',
                'presence.away': 'away',
                'presence.absent': 'absent',
                'presence.gone': 'gone',
                'presence.left': 'left',
                'presence.not_home': 'not home',
                
                // Command Keywords  
                'commands.turn_on': 'turn on',
                'commands.turn_off': 'turn off',
                'commands.switch_on': 'switch on',
                'commands.switch_off': 'switch off',
                'commands.set_to': 'set to',
                'commands.change_to': 'change to',
                'commands.activate': 'activate',
                'commands.deactivate': 'deactivate',
                'commands.enable': 'enable',
                'commands.disable': 'disable'
            },
            de: {
                // Intent Detection
                'intent.control_detected': 'Steuerungsabsicht erkannt',
                'intent.info_detected': 'Informationsanfrage erkannt',
                'intent.no_intent': 'Keine Absicht erkannt',
                'intent.scene_detected': 'Szenen-Aktion erkannt',
                'intent.confidence_low': 'Absicht-Vertrauen zu niedrig',
                
                // Datapoint Controller
                'datapoint.set_success': '{{datapoint}} erfolgreich auf {{value}} gesetzt',
                'datapoint.set_failed': 'Fehler beim Setzen von {{datapoint}}: {{error}}',
                'datapoint.not_allowed': 'Datenpunkt {{datapoint}} nicht für automatische Steuerung erlaubt',
                'datapoint.type_conversion_failed': 'Typkonvertierung fehlgeschlagen für {{value}} zu {{type}}',
                'datapoint.boolean_true': 'wahr',
                'datapoint.boolean_false': 'falsch',
                'datapoint.invalid_type': 'Ungültiger Datentyp: {{type}}',
                
                // Learning System
                'learning.action_recorded': 'Aktion für {{datapoint}} aufgezeichnet',
                'learning.scene_created': 'Szene "{{name}}" mit {{count}} Datenpunkten erstellt',
                'learning.association_learned': 'Assoziation zwischen {{primary}} und {{partner}} gelernt',
                'learning.data_saved': 'Lerndaten gespeichert',
                'learning.data_loaded': 'Lerndaten mit {{count}} Assoziationen geladen',
                
                // Tool Server
                'server.starting': 'ToolServer wird gestartet...',
                'server.started': 'ToolServer erfolgreich auf Port {{port}} gestartet',
                'server.failed_start': 'ToolServer-Start fehlgeschlagen: {{error}}',
                'server.stopping': 'ToolServer wird gestoppt...',
                'server.stopped': 'ToolServer gestoppt',
                'server.already_running': 'ToolServer läuft bereits',
                'server.chat_processed': 'Chat-Anfrage erfolgreich verarbeitet',
                'server.intent_processed': 'Intent-Anfrage verarbeitet',
                
                // Vector Database / RAG
                'vectordb.connection_ok': 'Vektordatenbank-Verbindung erfolgreich',
                'vectordb.connection_failed': 'Vektordatenbank-Verbindung fehlgeschlagen: {{error}}',
                'vectordb.embedding_generated': 'Embedding für {{text}} generiert',
                'vectordb.data_stored': 'Daten in Vektordatenbank gespeichert',
                'vectordb.duplicates_cleaned': '{{count}} doppelte Einträge bereinigt',
                'vectordb.search_completed': 'Vektorsuche mit {{count}} Ergebnissen abgeschlossen',
                
                // LLM Integration
                'llm.response_generated': 'LLM-Antwort generiert',
                'llm.request_failed': 'LLM-Anfrage fehlgeschlagen: {{error}}',
                'llm.model_unavailable': 'LLM-Modell nicht verfügbar',
                'llm.intent_analysis_complete': 'LLM-Intent-Analyse abgeschlossen',
                'llm.fallback_parsing': 'Fallback-Parsing für LLM-Antwort verwendet',
                
                // General Messages
                'general.initialized': '{{component}} erfolgreich initialisiert',
                'general.configuration_updated': 'Konfiguration aktualisiert',
                'general.error_occurred': 'Fehler aufgetreten: {{error}}',
                'general.operation_complete': 'Vorgang abgeschlossen',
                'general.invalid_input': 'Ungültige Eingabe: {{input}}',
                'general.not_available': '{{feature}} nicht verfügbar',
                
                // Presence/State Keywords
                'presence.home': 'zuhause',
                'presence.present': 'anwesend',
                'presence.available': 'verfügbar',
                'presence.here': 'da',
                'presence.arrived': 'angekommen',
                'presence.away': 'weg',
                'presence.absent': 'abwesend',
                'presence.gone': 'fort',
                'presence.left': 'verlassen',
                'presence.not_home': 'nicht zuhause',
                
                // Command Keywords
                'commands.turn_on': 'einschalten',
                'commands.turn_off': 'ausschalten',
                'commands.switch_on': 'anschalten',
                'commands.switch_off': 'abschalten',
                'commands.set_to': 'setzen auf',
                'commands.change_to': 'ändern auf',
                'commands.activate': 'aktivieren',
                'commands.deactivate': 'deaktivieren',
                'commands.enable': 'einschalten',
                'commands.disable': 'deaktivieren'
            }
        };

        // Load core translations
        for (const [lang, translations] of Object.entries(coreTranslations)) {
            this.translations.set(lang, translations);
        }

        this.log.debug(`[I18n] Loaded translations for languages: ${Array.from(this.translations.keys()).join(', ')}`);
    }

    /**
     * Set the current language
     * @param {string} language - Language code (en, de, etc.)
     */
    setLanguage(language) {
        if (this.supportedLanguages.includes(language)) {
            this.currentLanguage = language;
            this.log.debug(`[I18n] Language set to: ${language}`);
        } else {
            this.log.warn(`[I18n] Unsupported language: ${language}, using ${this.fallbackLanguage}`);
            this.currentLanguage = this.fallbackLanguage;
        }
    }

    /**
     * Get translation for a key
     * @param {string} key - Translation key
     * @param {Object} replacements - Object with replacement values
     * @returns {string} Translated text
     */
    translate(key, replacements = {}) {
        let translation = this._getTranslation(key, this.currentLanguage);
        
        // Fallback to English if translation not found
        if (translation === key && this.currentLanguage !== this.fallbackLanguage) {
            translation = this._getTranslation(key, this.fallbackLanguage);
        }

        // Apply replacements
        return this._applyReplacements(translation, replacements);
    }

    /**
     * Get translation for a specific language
     * @param {string} key - Translation key
     * @param {string} language - Language code
     * @returns {string} Translated text
     */
    translateFor(key, language, replacements = {}) {
        const translation = this._getTranslation(key, language) || this._getTranslation(key, this.fallbackLanguage) || key;
        return this._applyReplacements(translation, replacements);
    }

    /**
     * Get all translations for a language
     * @param {string} language - Language code
     * @returns {Object} All translations for the language
     */
    getAllTranslations(language) {
        return this.translations.get(language) || {};
    }

    /**
     * Get supported languages
     * @returns {Array} Array of supported language codes
     */
    getSupportedLanguages() {
        return [...this.supportedLanguages];
    }

    /**
     * Check if a language is supported
     * @param {string} language - Language code
     * @returns {boolean} True if language is supported
     */
    isLanguageSupported(language) {
        return this.supportedLanguages.includes(language);
    }

    /**
     * Get current language
     * @returns {string} Current language code
     */
    getCurrentLanguage() {
        return this.currentLanguage;
    }

    /**
     * Get presence keywords for current language
     * @returns {Object} Object with positive and negative presence keywords
     */
    getPresenceKeywords() {
        return {
            positive: [
                this.translate('presence.home'),
                this.translate('presence.present'),
                this.translate('presence.available'),
                this.translate('presence.here'),
                this.translate('presence.arrived')
            ],
            negative: [
                this.translate('presence.away'),
                this.translate('presence.absent'),
                this.translate('presence.gone'),
                this.translate('presence.left'),
                this.translate('presence.not_home')
            ]
        };
    }

    /**
     * Get command keywords for current language
     * @returns {Object} Object with command keywords
     */
    getCommandKeywords() {
        return {
            turnOn: this.translate('commands.turn_on'),
            turnOff: this.translate('commands.turn_off'),
            switchOn: this.translate('commands.switch_on'),
            switchOff: this.translate('commands.switch_off'),
            setTo: this.translate('commands.set_to'),
            changeTo: this.translate('commands.change_to'),
            activate: this.translate('commands.activate'),
            deactivate: this.translate('commands.deactivate'),
            enable: this.translate('commands.enable'),
            disable: this.translate('commands.disable')
        };
    }

    /**
     * Create a localized logger that translates log messages
     * @param {Object} baseLog - Base logger (e.g., adapter.log)
     * @returns {Object} Localized logger
     */
    createLocalizedLogger(baseLog) {
        return {
            info: (key, replacements) => baseLog.info(this.translate(key, replacements)),
            warn: (key, replacements) => baseLog.warn(this.translate(key, replacements)),
            error: (key, replacements) => baseLog.error(this.translate(key, replacements)),
            debug: (key, replacements) => baseLog.debug(this.translate(key, replacements)),
            
            // Direct methods for non-translated messages
            infoRaw: (message) => baseLog.info(message),
            warnRaw: (message) => baseLog.warn(message),
            errorRaw: (message) => baseLog.error(message),
            debugRaw: (message) => baseLog.debug(message)
        };
    }

    /**
     * Private method to get translation from translations map
     * @param {string} key - Translation key
     * @param {string} language - Language code
     * @returns {string} Translation or key if not found
     */
    _getTranslation(key, language) {
        const languageTranslations = this.translations.get(language);
        return languageTranslations?.[key] || key;
    }

    /**
     * Private method to apply replacements in translation
     * @param {string} translation - Translation text
     * @param {Object} replacements - Replacement values
     * @returns {string} Text with replacements applied
     */
    _applyReplacements(translation, replacements) {
        if (!replacements || Object.keys(replacements).length === 0) {
            return translation;
        }

        let result = translation;
        for (const [key, value] of Object.entries(replacements)) {
            const placeholder = `{{${key}}}`;
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }
        return result;
    }

    /**
     * Detect language from text (simple detection)
     * @param {string} text - Text to analyze
     * @returns {string} Detected language code
     */
    detectLanguage(text) {
        if (!text) return this.fallbackLanguage;

        const lowerText = text.toLowerCase();
        
        // Simple keyword-based detection
        const germanIndicators = ['ist', 'und', 'der', 'die', 'das', 'ein', 'eine', 'auf', 'mit', 'von', 'zu', 'in', 'an', 'für'];
        const englishIndicators = ['is', 'and', 'the', 'a', 'an', 'to', 'with', 'of', 'in', 'on', 'at', 'for'];

        let germanScore = 0;
        let englishScore = 0;

        germanIndicators.forEach(word => {
            if (lowerText.includes(word)) germanScore++;
        });

        englishIndicators.forEach(word => {
            if (lowerText.includes(word)) englishScore++;
        });

        if (germanScore > englishScore) {
            return 'de';
        } else if (englishScore > 0) {
            return 'en';
        }

        return this.fallbackLanguage;
    }
}

module.exports = I18n;
