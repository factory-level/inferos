import { afterEach, expect, it, vi } from "vitest";
import { measureServiceQueryPhase, recordServiceQueryTiming, serviceQueryHttpAttempt, withServiceQueryTiming } from "../src/service-query-timing";

afterEach(() => vi.restoreAllMocks());
it("separate RPCs retain their own attempt IDs across concurrent sends and retries", async () => {
  const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
  const ids = await Promise.all([1, 2].map(() => withServiceQueryTiming(async queryCallId => {
    const attempts: string[] = [];
    for (let n=0; n<2; n++) await serviceQueryHttpAttempt(async requestId => {
      await Promise.resolve(); attempts.push(requestId!);
    });
    return {queryCallId, attempts};
  })));
  expect(logs).toHaveBeenCalledTimes(2);
  expect(new Set(ids.flatMap(result => result.attempts)).size).toBe(4);
  for (const result of ids) {
    const line = logs.mock.calls.map(call => call[0]).find(entry => entry.queryCallId === result.queryCallId);
    expect(line.measurements.httpAttempts.map((attempt: {requestId: string}) => attempt.requestId)).toEqual(result.attempts);
    expect(line.measurements.phases.rpc.success).toBe(true);
  }
});
it("failure survives diagnostic logger failure; unsampled clients get no diagnostic header", async () => {
  vi.spyOn(console, "debug").mockImplementation(() => { throw new Error("logging unavailable"); });
  const error = new Error("provider refused");
  await expect(withServiceQueryTiming(() => measureServiceQueryPhase("provider", async () => {throw error;}))).rejects.toBe(error);
  await expect(serviceQueryHttpAttempt(async id => id)).resolves.toBeUndefined();
});
it("one completion bounds attempt metadata and ignores later detached measurements", async () => {
  const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
  let late!: () => void;
  let runLate!: () => void;
  const barrier = new Promise<void>(resolve => {runLate=resolve;});
  let detached: Promise<void> | undefined;
  await withServiceQueryTiming(async () => {
    for (let n=0; n<3; n++) await serviceQueryHttpAttempt(async () => {});
    late = () => recordServiceQueryTiming("http", 100, {success:true,requestId:crypto.randomUUID()});
    detached=barrier.then(late);
  });
  runLate(); await detached;
  const line=logs.mock.calls[0]![0];
  expect(logs).toHaveBeenCalledTimes(1);
  expect(line.measurements.httpAttempts).toHaveLength(2);
  expect(line.measurements.omittedAttempts).toBe(1);
  expect(line.measurements.phases.http.count).toBe(3);
});
