"use strict";

/**
 * Simple LRU Cache implementation for ioBroker.ollama
 * Optimized for managing processed states and preventing memory leaks
 */
class LRUCache {
  /**
   * Create a new LRU Cache
   *
   * @param {number} maxSize - Maximum number of items to store
   * @param {number|null} ttl - Time to live in milliseconds (optional)
   */
  constructor(maxSize = 1000, ttl = null) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
    this.accessOrder = new Map(); // Track access time for TTL
  }

  /**
   * Get item from cache
   *
   * @param {string} key - Cache key
   * @returns {*} Cached value or undefined
   */
  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Check TTL if configured
    if (this.ttl) {
      const accessTime = this.accessOrder.get(key);
      if (accessTime && Date.now() - accessTime > this.ttl) {
        this.delete(key);
        return undefined;
      }
    }

    // Move to end to mark as recently used
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);

    // Update access time
    if (this.ttl) {
      this.accessOrder.set(key, Date.now());
    }

    return value;
  }

  /**
   * Set item in cache
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   */
  set(key, value) {
    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // If at capacity, remove least recently used item
      const firstKey = this.cache.keys().next().value;
      this.delete(firstKey);
    }

    this.cache.set(key, value);

    // Track access time for TTL
    if (this.ttl) {
      this.accessOrder.set(key, Date.now());
    }
  }

  /**
   * Check if key exists in cache (without updating access order)
   *
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    // Check TTL if configured
    if (this.ttl) {
      const accessTime = this.accessOrder.get(key);
      if (accessTime && Date.now() - accessTime > this.ttl) {
        this.delete(key);
        return false;
      }
    }

    return true;
  }

  /**
   * Delete item from cache
   *
   * @param {string} key - Cache key
   * @returns {boolean} True if item was deleted
   */
  delete(key) {
    this.accessOrder.delete(key);
    return this.cache.delete(key);
  }

  /**
   * Clear all items from cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder.clear();
  }

  /**
   * Get current cache size
   *
   * @returns {number} Number of items in cache
   */
  size() {
    return this.cache.size;
  }

  /**
   * Get all keys in cache (most recently used last)
   *
   * @returns {Array} Array of cache keys
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Clean up expired items (if TTL is configured)
   *
   * @returns {number} Number of items removed
   */
  cleanup() {
    if (!this.ttl) {
      return 0;
    }

    let removed = 0;
    const now = Date.now();

    for (const [key, accessTime] of this.accessOrder.entries()) {
      if (now - accessTime > this.ttl) {
        this.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache statistics
   *
   * @returns {object} Cache statistics
   */
  getStats() {
    const stats = {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      utilization: `${((this.cache.size / this.maxSize) * 100).toFixed(2)}%`,
    };

    if (this.ttl) {
      const now = Date.now();
      let expired = 0;

      for (const accessTime of this.accessOrder.values()) {
        if (now - accessTime > this.ttl) {
          expired++;
        }
      }

      stats.expired = expired;
    }

    return stats;
  }
}

module.exports = LRUCache;
