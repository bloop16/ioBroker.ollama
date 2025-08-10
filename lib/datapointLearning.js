"use strict";

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Learning System for Datapoint Associations
 * Learns which datapoints are often controlled together and suggests scenes
 */
class DatapointLearning {
    constructor(adapter, log) {
        this.adapter = adapter;
        this.log = log;
        
        // Use system temp directory to avoid nodemon watching
        const os = require('os');
        const tempDir = os.tmpdir();
        const adapterTempDir = path.join(tempDir, 'iobroker-ollama');
        
        // Ensure temp directory exists
        if (!require('fs').existsSync(adapterTempDir)) {
            require('fs').mkdirSync(adapterTempDir, { recursive: true });
        }
        
        this.learningDataFile = path.join(adapterTempDir, `datapoint_learning_${this.adapter.namespace || 'default'}.json`);
        
        // Learning data structure
        this.learningData = {
            associations: {}, // datapointId -> { partners: {}, frequency: {} }
            scenes: {},       // scene_name -> { datapoints: [], usage_count: 0, last_used: timestamp }
            patterns: {},     // time-based patterns
            lastSave: Date.now()
        };
        
        // Configuration
        this.config = {
            maxAssociations: 100,
            minFrequencyThreshold: 3,
            timeWindowMs: 30000, // 30 seconds window for association
            maxScenes: 50,
            savingInterval: 300000 // Save every 5 minutes instead of 1 minute
        };
        
        this.pendingActions = new Map(); // Track recent actions for association learning
        this.saveTimer = null;
        this._hasUnsavedChanges = false; // Track if we have changes to save
        
        this.loadLearningData();
        this.startPeriodicSaving();
    }

    /**
     * Load learning data from file
     */
    loadLearningData() {
        try {
            if (fs.existsSync(this.learningDataFile)) {
                const data = fs.readFileSync(this.learningDataFile, 'utf8');
                this.learningData = { ...this.learningData, ...JSON.parse(data) };
                this.log.debug(`[Learning] Loaded learning data with ${Object.keys(this.learningData.associations).length} associations`);
            }
        } catch (error) {
            this.log.warn(`[Learning] Error loading learning data: ${error.message}`);
        }
    }

    /**
     * Save learning data to file
     */
    saveLearningData() {
        try {
            this.learningData.lastSave = Date.now();
            fs.writeFileSync(this.learningDataFile, JSON.stringify(this.learningData, null, 2));
            this.log.debug(`[Learning] Saved learning data`);
        } catch (error) {
            this.log.error(`[Learning] Error saving learning data: ${error.message}`);
        }
    }

    /**
     * Start periodic saving
     */
    startPeriodicSaving() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        
        // Only save if there are pending changes
        this.saveTimer = setInterval(() => {
            if (this.pendingActions.size > 0 || this._hasUnsavedChanges) {
                this.saveLearningData();
                this._hasUnsavedChanges = false;
            }
        }, this.config.savingInterval);
    }

    /**
     * Stop periodic saving
     */
    stop() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveLearningData(); // Final save
    }

    /**
     * Record a datapoint control action for learning
     * @param {string} datapointId - ID of the controlled datapoint
     * @param {*} value - Value that was set
     * @param {string} context - Context/reason for the action
     */
    recordAction(datapointId, value, context = '') {
        const timestamp = Date.now();
        const action = {
            datapointId,
            value,
            context,
            timestamp
        };

        // Add to pending actions
        this.pendingActions.set(datapointId, action);

        // Learn associations with recent actions
        this.learnAssociations(action);

        // Clean up old pending actions
        this.cleanupPendingActions(timestamp);
        
        // Mark that we have unsaved changes
        this._hasUnsavedChanges = true;

        this.log.debug(`[Learning] Recorded action for ${datapointId}: ${value}`);
    }

    /**
     * Record multiple datapoint actions at once (for scenes/batch operations)
     * @param {Array} datapointActions - Array of {id, value, context} objects
     */
    recordDatapointActions(datapointActions) {
        const timestamp = Date.now();
        
        // Record all actions with the same timestamp for better association learning
        for (const dpAction of datapointActions) {
            const action = {
                datapointId: dpAction.id,
                value: dpAction.value,
                context: dpAction.context || '',
                timestamp
            };

            this.pendingActions.set(dpAction.id, action);
            this.log.debug(`[Learning] Recorded action for ${dpAction.id}: ${dpAction.value}`);
        }

        // Learn associations between all these datapoints
        for (const dpAction of datapointActions) {
            const action = {
                datapointId: dpAction.id,
                value: dpAction.value,
                context: dpAction.context || '',
                timestamp
            };
            this.learnAssociations(action);
        }

        // Clean up old pending actions
        this.cleanupPendingActions(timestamp);
        
        // Mark that we have unsaved changes
        this._hasUnsavedChanges = true;
    }

    /**
     * Learn associations between datapoints
     * @param {Object} currentAction - Current action being performed
     */
    learnAssociations(currentAction) {
        const currentTime = currentAction.timestamp;
        const currentId = currentAction.datapointId;

        // Initialize association data for current datapoint
        if (!this.learningData.associations[currentId]) {
            this.learningData.associations[currentId] = {
                partners: {},
                frequency: {},
                contexts: {}
            };
        }

        // Find recent actions to associate with
        for (const [partnerId, partnerAction] of this.pendingActions.entries()) {
            if (partnerId === currentId) continue; // Skip self

            const timeDiff = currentTime - partnerAction.timestamp;
            if (timeDiff <= this.config.timeWindowMs) {
                // Learn the association
                this.recordAssociation(currentId, partnerId, currentAction.context);
                this.recordAssociation(partnerId, currentId, partnerAction.context);
            }
        }
    }

    /**
     * Record an association between two datapoints
     * @param {string} primaryId - Primary datapoint ID
     * @param {string} partnerId - Associated datapoint ID
     * @param {string} context - Context of the association
     */
    recordAssociation(primaryId, partnerId, context) {
        const associations = this.learningData.associations[primaryId];
        
        // Increment partner frequency
        associations.partners[partnerId] = (associations.partners[partnerId] || 0) + 1;
        
        // Record context
        if (context) {
            if (!associations.contexts[partnerId]) {
                associations.contexts[partnerId] = {};
            }
            associations.contexts[partnerId][context] = (associations.contexts[partnerId][context] || 0) + 1;
        }

        // Update total frequency
        associations.frequency[partnerId] = associations.partners[partnerId];
    }

    /**
     * Get suggested datapoints that are often controlled together
     * @param {string} datapointId - Primary datapoint
     * @param {number} minFrequency - Minimum frequency threshold
     * @returns {Array} Array of suggested datapoint IDs with frequencies
     */
    getSuggestedPartners(datapointId, minFrequency = 1) {
        const threshold = minFrequency || this.config.minFrequencyThreshold;
        const associations = this.learningData.associations[datapointId];
        
        if (!associations) {
            return [];
        }

        return Object.entries(associations.partners)
            .filter(([_, frequency]) => frequency >= threshold)
            .sort((a, b) => b[1] - a[1]) // Sort by frequency descending
            .map(([partnerId, frequency]) => ({
                datapointId: partnerId,
                frequency,
                contexts: associations.contexts[partnerId] || {}
            }));
    }

    /**
     * Create a scene from frequently associated datapoints
     * @param {string} mainDatapointId - Primary datapoint
     * @param {string} sceneName - Name for the scene
     * @returns {Object} Created scene or null
     */
    createSceneFromAssociations(mainDatapointId, sceneName) {
        const partners = this.getSuggestedPartners(mainDatapointId);
        
        if (partners.length === 0) {
            return null;
        }

        // Get current values of associated datapoints
        const sceneDatapoints = [mainDatapointId, ...partners.map(p => p.datapointId)];
        const scene = {
            name: sceneName,
            datapoints: sceneDatapoints,
            created: new Date().toISOString(),
            usage_count: 0,
            last_used: null,
            learned: true,
            associations: partners
        };

        this.learningData.scenes[sceneName] = scene;
        this.log.info(`[Learning] Created scene "${sceneName}" with ${sceneDatapoints.length} datapoints`);
        
        return scene;
    }

    /**
     * Get all learned scenes
     * @returns {Array} Array of scene objects
     */
    getLearnedScenes() {
        return Object.values(this.learningData.scenes)
            .sort((a, b) => b.usage_count - a.usage_count);
    }

    /**
     * Record scene usage
     * @param {string} sceneName - Name of the used scene
     */
    recordSceneUsage(sceneName) {
        if (this.learningData.scenes[sceneName]) {
            this.learningData.scenes[sceneName].usage_count++;
            this.learningData.scenes[sceneName].last_used = new Date().toISOString();
        }
    }

    /**
     * Suggest scene creation based on learning data
     * @param {number} minAssociations - Minimum number of associations required
     * @returns {Array} Array of scene suggestions
     */
    suggestScenes(minAssociations = 2) {
        const suggestions = [];
        
        for (const [datapointId, data] of Object.entries(this.learningData.associations)) {
            const partners = this.getSuggestedPartners(datapointId);
            
            if (partners.length >= minAssociations) {
                // Check if scene already exists
                const existingScene = Object.values(this.learningData.scenes)
                    .find(scene => scene.datapoints.includes(datapointId));
                
                if (!existingScene) {
                    suggestions.push({
                        mainDatapoint: datapointId,
                        partners: partners,
                        suggestedName: this.generateSceneName(datapointId, partners),
                        strength: partners.reduce((sum, p) => sum + p.frequency, 0)
                    });
                }
            }
        }
        
        return suggestions.sort((a, b) => b.strength - a.strength);
    }

    /**
     * Generate a meaningful scene name
     * @param {string} mainDatapoint - Primary datapoint
     * @param {Array} partners - Associated datapoints
     * @returns {string} Generated scene name
     */
    generateSceneName(mainDatapoint, partners) {
        // Try to extract meaningful names from datapoint IDs
        const extractName = (id) => {
            const parts = id.split('.');
            return parts[parts.length - 1].replace(/[_-]/g, ' ');
        };

        const mainName = extractName(mainDatapoint);
        const partnerNames = partners.slice(0, 2).map(p => extractName(p.datapointId));
        
        if (partnerNames.length > 0) {
            return `${mainName} + ${partnerNames.join(', ')}`;
        }
        
        return `Scene ${mainName}`;
    }

    /**
     * Clean up old pending actions
     * @param {number} currentTime - Current timestamp
     */
    cleanupPendingActions(currentTime) {
        for (const [id, action] of this.pendingActions.entries()) {
            if (currentTime - action.timestamp > this.config.timeWindowMs * 2) {
                this.pendingActions.delete(id);
            }
        }
    }

    /**
     * Get learning statistics
     * @returns {Object} Statistics about learned data
     */
    getStatistics() {
        const associationCount = Object.keys(this.learningData.associations).length;
        const sceneCount = Object.keys(this.learningData.scenes).length;
        const totalAssociations = Object.values(this.learningData.associations)
            .reduce((sum, data) => sum + Object.keys(data.partners).length, 0);
        
        return {
            totalDatapointsWithAssociations: associationCount,
            totalAssociations,
            totalScenes: sceneCount,
            pendingActions: this.pendingActions.size,
            lastSave: this.learningData.lastSave
        };
    }

    /**
     * Reset learning data (for testing or cleanup)
     */
    resetLearningData() {
        this.learningData = {
            associations: {},
            scenes: {},
            patterns: {},
            lastSave: Date.now()
        };
        this.pendingActions.clear();
        this.saveLearningData();
        this.log.info('[Learning] Learning data reset');
    }
}

module.exports = DatapointLearning;
