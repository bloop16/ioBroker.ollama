const fs = require('fs');
const path = require('path');

/**
 * Tool Server Singleton Controller
 * Prevents multiple Tool Server instances from running
 */
class ToolServerController {
    constructor() {
        this.lockFile = path.join(__dirname, '..', '.tool-server.lock');
        this.pidFile = path.join(__dirname, '..', '.tool-server.pid');
    }

    /**
     * Check if another Tool Server instance is already running
     * @returns {Promise<boolean>} True if another instance is running
     */
    async isRunning() {
        try {
            if (fs.existsSync(this.lockFile)) {
                const lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
                const pid = lockData.pid;
                const port = lockData.port;
                
                // Check if process is still alive
                try {
                    process.kill(pid, 0);
                    // Process exists, check if it's actually our tool server
                    return await this._verifyToolServer(port);
                } catch (error) {
                    // Process doesn't exist, remove stale lock file
                    this._cleanup();
                    return false;
                }
            }
            return false;
        } catch (error) {
            // Error reading lock file, assume not running
            this._cleanup();
            return false;
        }
    }

    /**
     * Verify that the process on the port is actually our Tool Server
     * @param {number} port - Port to check
     * @returns {Promise<boolean>}
     */
    async _verifyToolServer(port) {
        try {
            const axios = require('axios');
            const response = await axios.get(`http://localhost:${port}/health`, { 
                timeout: 2000,
                validateStatus: (status) => status === 200
            });
            
            const isValidServer = response.data?.service === 'ioBroker Ollama Tool Server';
            
            if (!isValidServer) {
                // Port is occupied by different service, clean up stale lock
                this._cleanup();
            }
            
            return isValidServer;
        } catch (error) {
            // Health check failed, likely not our server or server down
            this._cleanup();
            return false;
        }
    }

    /**
     * Create lock file for current instance
     * @param {number} port - Port the server is running on
     * @returns {boolean} True if lock was created successfully
     */
    createLock(port) {
        try {
            const lockData = {
                pid: process.pid,
                port: port,
                timestamp: new Date().toISOString(),
                host: require('os').hostname()
            };
            
            fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2));
            
            // Also create a simpler PID file
            fs.writeFileSync(this.pidFile, process.pid.toString());
            
            return true;
        } catch (error) {
            console.error('Failed to create lock file:', error.message);
            return false;
        }
    }

    /**
     * Remove lock files
     */
    _cleanup() {
        try {
            if (fs.existsSync(this.lockFile)) {
                fs.unlinkSync(this.lockFile);
            }
            if (fs.existsSync(this.pidFile)) {
                fs.unlinkSync(this.pidFile);
            }
        } catch (error) {
            // Ignore cleanup errors
        }
    }

    /**
     * Clean up when process exits
     */
    cleanup() {
        this._cleanup();
    }

    /**
     * Get information about running instance
     * @returns {object|null} Instance info or null if not running
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
}

module.exports = ToolServerController;
