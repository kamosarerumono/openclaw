import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { startOpenClawDatabaseIntegrityVerifier } from "./openclaw-database-verify.js";
import { readOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

assert.equal(isMainThread, true, "Broker admission must run on the real host thread");
await withOpenClawTestState({ label: "database-verifier-worker-relay" }, async ({ env }) => {
  const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
  closeOpenClawAgentDatabaseByPath(agent.path);
  const before = readOpenClawAgentIntegrityVerification(agent.path, env);
  assert.equal(before?.clean_close, 1);
  assert.ok(before);

  const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
  const context = captureOpenClawStateWorkerContext({ env });
  const generation = createAgentDatabaseNativeGeneration(
    agent.agentId,
    agent.path,
    context,
    context.admission.assertCurrent,
    context.admission.assertCurrent,
    undefined,
    () => {},
  );
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: context.admission.assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          context.admission.assertCurrent();
          assert.ok(grant(), "Synthetic database admission expired");
        }),
      });
    },
  };
  try {
    await generation.runExisting(source, (scope) =>
      scope.execute({ type: "database.prepareWrite", input: undefined }),
    );
    const deadline = performance.now() + 20_000;
    for (;;) {
      const current = readOpenClawAgentIntegrityVerification(agent.path, env);
      assert.ok(current);
      assert.equal(current.dev, before.dev);
      assert.equal(current.ino, before.ino);
      assert.equal(current.clean_close, 0);
      if (current.verified_at > before.verified_at) {
        break;
      }
      assert.ok(performance.now() < deadline, "Cached Worker open never completed its quick check");
      await delay(20);
    }
  } finally {
    await verifier.stop();
    await generation.close();
    await drainGlobalSingletonLifecycleState();
  }
});
