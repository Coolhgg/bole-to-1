/** @jest-environment node */
import { prisma } from '@/lib/prisma';
import { logSecurityEvent, wrapWithDLQ } from '@/lib/api-utils';
import { v4 as uuidv4 } from 'uuid';

describe('Worker DLQ and Audit Logging Integration Tests', () => {
  let testUser: any;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        id: uuidv4(),
        email: `qa-audit-${Date.now()}@example.com`,
        username: `qa_auditor_${Date.now()}`,
      }
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { user_id: testUser.id } });
    await prisma.workerFailure.deleteMany({ where: { queue_name: 'test-queue' } });
    await prisma.user.delete({ where: { id: testUser.id } });
  });

  test('logSecurityEvent should create an audit log entry', async () => {
    const event = 'TEST_EVENT';
    const metadata = { foo: 'bar' };

    await logSecurityEvent({
      userId: testUser.id,
      event,
      status: 'success',
      ipAddress: '127.0.0.1',
      userAgent: 'Jest',
      metadata
    });

    const log = await prisma.auditLog.findFirst({
      where: { user_id: testUser.id, event }
    });

    expect(log).toBeDefined();
    expect(log?.status).toBe('success');
    expect(log?.metadata).toMatchObject(metadata);
  });

  test('wrapWithDLQ should log failure on last attempt', async () => {
    const queueName = 'test-queue';
    const errorMsg = 'Persistent Failure';
    
    const failingProcessor = async () => {
      throw new Error(errorMsg);
    };

    const wrapped = wrapWithDLQ(queueName, failingProcessor);

    const mockJob = {
      id: 'test-job-dlq',
      data: { some: 'data' },
      attemptsMade: 2, // 3rd attempt
      opts: { attempts: 3 }
    };

    // Should throw error but also log to DLQ
    await expect(wrapped(mockJob)).rejects.toThrow(errorMsg);

    const failure = await prisma.workerFailure.findFirst({
      where: { queue_name: queueName, job_id: 'test-job-dlq' }
    });

    expect(failure).toBeDefined();
    expect(failure?.error_message).toBe(errorMsg);
    expect(failure?.attempts_made).toBe(3);
    expect(failure?.payload).toMatchObject({ some: 'data' });
  });

  test('wrapWithDLQ should NOT log failure if not last attempt', async () => {
    const queueName = 'test-queue-no-dlq';
    const errorMsg = 'Transient Failure';
    
    const failingProcessor = async () => {
      throw new Error(errorMsg);
    };

    const wrapped = wrapWithDLQ(queueName, failingProcessor);

    const mockJob = {
      id: 'test-job-no-dlq',
      data: { some: 'data' },
      attemptsMade: 0, // 1st attempt
      opts: { attempts: 3 }
    };

    await expect(wrapped(mockJob)).rejects.toThrow(errorMsg);

    const failure = await prisma.workerFailure.findFirst({
      where: { queue_name: queueName, job_id: 'test-job-no-dlq' }
    });

    expect(failure).toBeNull();
  });
});
