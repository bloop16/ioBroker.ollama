"use strict";

const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * ToolServer Singleton Controller
 * Ensures only one ToolServer instance runs at a time
 */
class ToolServerController {
    constructor() {
        this.lockFile = path.join(__dirname, '..', '.toolserver.lock');
        this.healthCheckTimeout = 3000; // 3 seconds timeout for health checks
    }

    /**
     * Check if a ToolServer is already running
     * @returns {Promise<boolean>} True if a ToolServer is running
     */
    async isRunning() {
        try {
            // Check if lock file exists
            if (!fs.existsSync(this.lockFile)) {
                return false;
            }

            // Read lock file
            const lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
            const { pid, port } = lockData;

            // Check if process is still alive
            if (!this._isProcessAlive(pid)) {
                this._removeLockFile();
                return false;
            }

            // Verify that the process is actually our ToolServer by checking health endpoint
            const isHealthy = await this._checkHealthEndpoint(port);
            if (!isHealthy) {
                this._removeLockFile();
                return false;
            }

            return true;

        } catch (error) {
            // If there's an error reading the lock file, assume it's corrupted and clean it up
            this._removeLockFile();
            return false;
        }
    }

    /**
     * Create a lock file for the current ToolServer instance
     * @param {number} port - Port the ToolServer is running on
     * @returns {boolean} True if lock was created successfully
     */
    createLock(port) {
        try {
            const lockData = {
                pid: process.pid,
                port: port,
                timestamp: new Date().toISOString(),
                hostname: require('os').hostname()
            };

            fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2));
            return true;

        } catch (error) {
            return false;
        }
    }

    /**
     * Remove the lock file
     */
    cleanup() {
        this._removeLockFile();
    }

    /**
     * Get information about the running ToolServer instance
     * @returns {object|null} Lock data or null if no lock exists
     */
    getRunningInstance() {
        try {
            if (fs.existsSync(this.lockFile)) {
                return JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
            }
        } catch (error) {
            // Ignore errors
        }
        return null;
    }

    /**
     * Check if a process is still alive
     * @param {number} pid - Process ID to check
     * @returns {boolean} True if process is alive
     */
    _isProcessAlive(pid) {
        try {
            // Sending signal 0 to a process checks if it exists without actually killing it
            process.kill(pid, 0);
            return true;
        } catch (error) {
            // If error code is 'ESRCH', the process doesn't exist
            return error.code !== 'ESRCH';
        }
    }

    /**
     * Check if the ToolServer health endpoint is responding
     * @param {number} port - Port to check
     * @param {string} host - Host to check (defaults to localhost for health checks)
     * @returns {Promise<boolean>} True if health endpoint responds correctly
     */
    async _checkHealthEndpoint(port, host = 'localhost') {
        try {
            const response = await axios.get(`http://${host}:${port}/health`, {
                timeout: this.healthCheckTimeout,
                validateStatus: (status) => status === 200
            });

            // Verify it's actually our ToolServer
            return response.data?.service === 'ioBroker Ollama Tool Server';

        } catch (error) {
            return false;
        }
    }

    /**
     * Remove the lock file
     */
    _removeLockFile() {
        try {
            if (fs.existsSync(this.lockFile)) {
                fs.unlinkSync(this.lockFile);
            }
        } catch (error) {
            // Ignore errors
        }
    }
}

module.exports = ToolServerController;
