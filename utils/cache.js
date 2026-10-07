// ============================================================
// Memory Cache Utility to dramatically reduce Supabase Egress
// ============================================================

class MemoryCache {
    constructor() {
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiresAt) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }

    set(key, value, ttlSeconds = 30) {
        this.cache.set(key, {
            value,
            expiresAt: Date.now() + (ttlSeconds * 1000)
        });
    }

    delete(key) {
        this.cache.delete(key);
    }

    clearByPattern(prefix) {
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }

    clear() {
        this.cache.clear();
    }
}

const memoryCache = new MemoryCache();

module.exports = memoryCache;
