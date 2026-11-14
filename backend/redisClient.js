/**
 * Redis Adapter & Distributed Cache Engine
 * Provides distributed caching, single-flight locking, and cross-PM2 deduplication
 * with seamless in-memory fallback when Redis is offline or not configured.
 */

const Redis = require('ioredis');

class RedisClient {
  constructor() {
    this.redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.prefix = process.env.REDIS_KEY_PREFIX || 'casinotv:';
    this.isConnected = false;
    this.client = null;
    this.workerId = `worker_${process.pid}_${Math.random().toString(36).substring(2, 7)}`;
    
    // In-memory fallback store
    this.memoryStore = new Map(); // key -> { value, expiresAt }
    this.memoryLocks = new Map(); // key -> { owner, expiresAt }
    this.memoryMetrics = new Map(); // key -> field -> value

    this._init();
  }

  _init() {
    try {
      this.client = new Redis(this.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        enableOfflineQueue: false,
        retryStrategy: (times) => {
          if (times > 10) return null; // Stop reconnecting after 10 attempts
          return Math.min(times * 1000, 5000);
        }
      });

      // Suppress unhandled error events
      this.client.on('error', (err) => {
        if (this.isConnected) {
          console.warn('[Redis] Connection error, degrading to in-memory fallback:', err.message);
        }
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log(`[Redis] Connected to Redis at ${this.redisUrl.replace(/:[^:@]*@/, ':***@')} (Distributed deduplication active)`);
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

      // Attempt initial connection asynchronously
      this.client.connect().catch((err) => {
        this.isConnected = false;
        console.log(`[Redis] Redis offline or not running (${err.code || err.message}). Operating in high-performance in-memory fallback mode.`);
      });
    } catch (e) {
      this.isConnected = false;
      console.warn('[Redis] Redis client initialization failed:', e.message);
    }
  }

  _k(key) {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  // --- Key-Value Cache Operations ---

  async get(key) {
    const fullKey = this._k(key);
    if (this.isConnected && this.client) {
      try {
        const raw = await this.client.get(fullKey);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (_) {
          return raw;
        }
      } catch (err) {
        this.isConnected = false;
      }
    }

    // In-memory fallback
    const item = this.memoryStore.get(fullKey);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryStore.delete(fullKey);
      return null;
    }
    return item.value;
  }

  async set(key, value, ttlSeconds = 900) {
    const fullKey = this._k(key);
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

    if (this.isConnected && this.client) {
      try {
        if (ttlSeconds && ttlSeconds > 0) {
          await this.client.set(fullKey, serialized, 'EX', ttlSeconds);
        } else {
          await this.client.set(fullKey, serialized);
        }
        return true;
      } catch (err) {
        this.isConnected = false;
      }
    }

    // In-memory fallback
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + (ttlSeconds * 1000) : null;
    this.memoryStore.set(fullKey, { value, expiresAt });
    return true;
  }

  async del(key) {
    const fullKey = this._k(key);
    if (this.isConnected && this.client) {
      try {
        await this.client.del(fullKey);
      } catch (_) {
        this.isConnected = false;
      }
    }
    this.memoryStore.delete(fullKey);
    return true;
  }

  // --- Distributed Lock (Single-Flight Across PM2 Workers) ---

  /**
   * Acquire a distributed lock.
   * Returns true if lock was acquired, false if held by another worker.
   */
  async acquireLock(lockKey, ttlSeconds = 15) {
    const fullKey = this._k(`lock:${lockKey}`);
    if (this.isConnected && this.client) {
      try {
        // SET key workerId NX EX ttlSeconds (Atomic distributed mutex)
        const result = await this.client.set(fullKey, this.workerId, 'NX', 'EX', ttlSeconds);
        return result === 'OK';
      } catch (err) {
        this.isConnected = false;
      }
    }

    // In-memory fallback mutex
    const now = Date.now();
    const existing = this.memoryLocks.get(fullKey);
    if (existing && now < existing.expiresAt) {
      return false; // Lock is held
    }
    this.memoryLocks.set(fullKey, {
      owner: this.workerId,
      expiresAt: now + (ttlSeconds * 1000)
    });
    return true;
  }

  /**
   * Release a distributed lock.
   */
  async releaseLock(lockKey) {
    const fullKey = this._k(`lock:${lockKey}`);
    if (this.isConnected && this.client) {
      try {
        // Lua script to safely release only if current worker is owner
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await this.client.eval(luaScript, 1, fullKey, this.workerId);
      } catch (_) {
        this.isConnected = false;
      }
    }

    const existing = this.memoryLocks.get(fullKey);
    if (existing && existing.owner === this.workerId) {
      this.memoryLocks.delete(fullKey);
    }
    return true;
  }

  /**
   * Wait for a lock held by another worker to be released.
   */
  async waitForLock(lockKey, maxWaitMs = 10000, pollIntervalMs = 200) {
    const startTime = Date.now();
    const fullKey = this._k(`lock:${lockKey}`);

    while (Date.now() - startTime < maxWaitMs) {
      if (this.isConnected && this.client) {
        try {
          const exists = await this.client.exists(fullKey);
          if (!exists) return true; // Lock released!
        } catch (_) {
          this.isConnected = false;
        }
      } else {
        const item = this.memoryLocks.get(fullKey);
        if (!item || Date.now() > item.expiresAt) {
          return true; // Lock released!
        }
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    return false; // Timed out
  }

  // --- Metrics and Counter Operations ---

  async incr(key, by = 1) {
    const fullKey = this._k(key);
    if (this.isConnected && this.client) {
      try {
        return await this.client.incrby(fullKey, by);
      } catch (_) {
        this.isConnected = false;
      }
    }
    const curr = (this.memoryStore.get(fullKey)?.value || 0) + by;
    this.memoryStore.set(fullKey, { value: curr, expiresAt: null });
    return curr;
  }

  async hset(hashKey, field, value) {
    const fullKey = this._k(hashKey);
    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);

    if (this.isConnected && this.client) {
      try {
        await this.client.hset(fullKey, field, valStr);
        return true;
      } catch (_) {
        this.isConnected = false;
      }
    }

    let h = this.memoryMetrics.get(fullKey);
    if (!h) {
      h = new Map();
      this.memoryMetrics.set(fullKey, h);
    }
    h.set(field, value);
    return true;
  }

  async hgetall(hashKey) {
    const fullKey = this._k(hashKey);
    if (this.isConnected && this.client) {
      try {
        const res = await this.client.hgetall(fullKey);
        if (res && Object.keys(res).length > 0) return res;
      } catch (_) {
        this.isConnected = false;
      }
    }

    const h = this.memoryMetrics.get(fullKey);
    if (!h) return {};
    const obj = {};
    for (const [k, v] of h.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  // --- Observability Status ---

  getStatus() {
    return {
      connected: this.isConnected,
      mode: this.isConnected ? 'redis_distributed' : 'in_memory_fallback',
      url: this.redisUrl.replace(/:[^:@]*@/, ':***@'),
      workerId: this.workerId,
      memoryKeysCount: this.memoryStore.size,
      memoryLocksCount: this.memoryLocks.size
    };
  }
}

module.exports = new RedisClient();
