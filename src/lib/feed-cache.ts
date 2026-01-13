type CachedFeed = {
  items: any[];
  timestamp: number;
  type: string;
};

const CACHE_KEY_PREFIX = 'kenmei_feed_cache_';
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

export const FeedCache = {
  get(type: string): any[] | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(`${CACHE_KEY_PREFIX}${type}`);
      if (!raw) return null;
      
      const cached: CachedFeed = JSON.parse(raw);
      if (Date.now() - cached.timestamp > CACHE_TTL) {
        localStorage.removeItem(`${CACHE_KEY_PREFIX}${type}`);
        return null;
      }
      
      return cached.items;
    } catch (e) {
      return null;
    }
  },

  set(type: string, items: any[]): void {
    if (typeof window === 'undefined') return;
    try {
      const cached: CachedFeed = {
        items,
        timestamp: Date.now(),
        type,
      };
      localStorage.setItem(`${CACHE_KEY_PREFIX}${type}`, JSON.stringify(cached));
    } catch (e) {}
  },

  invalidate(type?: string): void {
    if (typeof window === 'undefined') return;
    if (type) {
      localStorage.removeItem(`${CACHE_KEY_PREFIX}${type}`);
    } else {
      // Invalidate all feed caches
      Object.keys(localStorage)
        .filter(key => key.startsWith(CACHE_KEY_PREFIX))
        .forEach(key => localStorage.removeItem(key));
    }
    window.dispatchEvent(new CustomEvent('feed-cache-invalidated', { detail: { type } }));
  }
};
