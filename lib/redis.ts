// Import required modules
import { RedisClientType, createClient } from "redis";

// Create Redis client with standard connection
export const redis: RedisClientType = createClient({
  url: `redis://${process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ""}${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || "6379"}`,
});

// Connect to Redis (needs to be called once when the app starts)
redis
  .connect()
  .catch((err: Error) => console.error("Redis connection error:", err));

// Create a second Redis client for locking operations
export const lockerRedisClient: RedisClientType = createClient({
  url: `redis://${process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ""}${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || "6379"}`,
  database: 1, // Use a different DB for locking
});

// Connect the locker client
lockerRedisClient
  .connect()
  .catch((err: Error) => console.error("Redis locker connection error:", err));

// Create a compatible rate limiter implementation that matches the Upstash interface
export const ratelimit = (
  requests: number = 10,
  duration: number = 10, // In seconds
) => {
  // Instead of express-rate-limit, we'll implement a simple rate limiter using Redis
  // that matches the Upstash interface with a 'limit' method
  const prefix = "papermark:rl:";

  return {
    // The limit function checks if we should allow the request
    limit: async (identifier: string) => {
      const key = `${prefix}${identifier}`;
      const now = Date.now();
      const windowMs = duration * 1000;

      try {
        // Use Redis to implement the sliding window algorithm
        const multi = redis.multi();

        // Clean up old entries outside the current window
        multi.zRemRangeByScore(key, 0, now - windowMs);

        // Add the current request
        multi.zAdd(key, { score: now, value: now.toString() });

        // Count requests in the window
        multi.zCard(key);

        // Set expiration for cleanup
        multi.expire(key, Math.ceil(duration * 1.5)); // 1.5x the window for safety

        const results = await multi.exec();
        const count = (results?.[2] as number) || 0;

        const success = count <= requests;
        const remaining = Math.max(0, requests - count);
        const reset = now + windowMs;

        return {
          success, // true if under the limit
          limit: requests,
          remaining,
          reset,
          pending: Promise.resolve(null),
        };
      } catch (err) {
        console.error("Rate limit error:", err);
        // On error, allow the request (fail open to prevent blocking all traffic)
        return {
          success: true,
          limit: requests,
          remaining: 1,
          reset: now + windowMs,
          pending: Promise.resolve(null),
        };
      }
    },
  };
};
