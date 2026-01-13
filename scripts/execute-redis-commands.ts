import { redisWorker, redisApi, waitForRedis } from '../src/lib/redis';

async function main() {
  console.log('--- Executing Redis Commands ---');

  console.log('Waiting for Redis Worker...');
  const workerReady = await waitForRedis(redisWorker, 10000);
  if (!workerReady) {
    console.error('Redis Worker failed to connect');
    process.exit(1);
  }

  const keysToDel = [
    'kenmei:production:workers:global',
    'kenmei:production:lock:scheduler:master',
    'kenmei:production:workers:heartbeat'
  ];

  for (const key of keysToDel) {
    console.log(`Deleting ${key}...`);
    try {
      const result = await redisWorker.del(key);
      console.log(`Result: ${result}`);
    } catch (err) {
      console.error(`Failed to delete ${key}:`, err.message);
    }
  }

  console.log('Waiting for Redis API...');
  const apiReady = await waitForRedis(redisApi, 5000);
  if (!apiReady) {
     console.error('Redis API failed to connect');
  } else {
    console.log('Getting kenmei:production:workers:heartbeat...');
    try {
      const heartbeat = await redisApi.get('kenmei:production:workers:heartbeat');
      console.log('Heartbeat:', heartbeat);
    } catch (err) {
      console.error('Failed to get heartbeat:', err.message);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
