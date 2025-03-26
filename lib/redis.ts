// Import express-rate-limit and Redis store
import { rateLimit } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
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

// Create a new ratelimiter function that returns a configured rate limiter
export const ratelimit = (
  requests: number = 10,
  duration: number = 10, // In seconds
) => {
  return rateLimit({
    windowMs: duration * 1000,
    max: requests,
    standardHeaders: true,
    store: new RedisStore({
      // @ts-ignore - Type issue with sendCommand in the rate-limit-redis types
      sendCommand: (...args: string[]) => redis.sendCommand(args),
      prefix: "papermark:rl:",
    }),
  });
};
