import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createQueekClient,
  type OperationResponse,
  type QueekClient,
  type StoreProfile,
} from "../src/client.js";
import { createInstallationClient } from "../src/tokens.js";
import { fakeApiKey } from "./helpers.js";

/**
 * Proof that an app's own codegen types flow through the generic client
 * with NO SDK change. `AppStorePaths` stands in for the app-owned
 * `types/merchant.ts` after the Merchant API ships a new field
 * (`loyalty_points`); the bundled SDK types never mention it.
 */
interface AppStorePaths {
  "/store": {
    get: {
      responses: {
        200: {
          content: {
            "application/json": {
              data: { p_id: string; name: string; loyalty_points: number };
            };
          };
        };
      };
    };
  };
}

type AppStore = OperationResponse<"/store", "get", AppStorePaths>;

const API_BASE = "https://api.usequeek.com/api/v1/merchant";
const API_KEY = fakeApiKey("installation");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generic client types (enforced by `npm run typecheck:tests`)", () => {
  it("default shim equals the bundled OperationResponse (compat guard)", () => {
    // A refactor changing the default's meaning breaks this at typecheck.
    expectTypeOf<StoreProfile>().toEqualTypeOf<OperationResponse<"/store", "get">>();
  });

  it("paths without /store resolve to unknown, never `never` (empty-paths guard)", () => {
    // biome-ignore lint/complexity/noBannedTypes: `{}` IS the edge under test (a paths object with no keys).
    expectTypeOf<StoreProfile<{}>>().toEqualTypeOf<unknown>();
  });

  it("ReturnType<typeof createInstallationClient> is exactly the default QueekClient", () => {
    // The alias every real app uses. TS instantiates the unconstrained
    // generic at `unknown` (ignoring `= paths`); without the StoreProfile
    // collapse this became QueekClient<unknown> and broke apps that use the alias.
    expectTypeOf<ReturnType<typeof createInstallationClient>>().toEqualTypeOf<QueekClient>();
    expectTypeOf<ReturnType<typeof createQueekClient>>().toEqualTypeOf<QueekClient>();
  });

  it("consumer pattern: the ReturnType alias is mutually assignable with QueekClient", () => {
    type InstallationClient = ReturnType<typeof createInstallationClient>;
    expectTypeOf<InstallationClient>().toExtend<QueekClient>();
    expectTypeOf<QueekClient>().toExtend<InstallationClient>();
    // Alias passed where a QueekClient is expected and back (lifecycle.ts pattern).
    const take = (c: QueekClient): InstallationClient => c;
    const give = (c: InstallationClient): QueekClient => c;
    expect(typeof take).toBe("function");
    expect(typeof give).toBe("function");
  });

  it("OperationResponse extracts the app's body over app-owned paths", () => {
    expectTypeOf<AppStore>().toEqualTypeOf<{
      data: { p_id: string; name: string; loyalty_points: number };
    }>();
  });
});

describe("generic client (app-owned paths flow through)", () => {
  it("createQueekClient<AppPaths>.getStore() types the app's extra field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { p_id: "store_xyz", name: "Test", loyalty_points: 42 } }),
    );
    const client = createQueekClient<AppStorePaths>({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const store = await client.getStore();
    // Type-level proof: without the generic this line does not compile
    // (`loyalty_points` is unknown to the bundled SDK types).
    const points: number = store.data.loyalty_points;
    const viaHelper: AppStore = store;
    expect(points).toBe(42);
    expect(viaHelper.data.p_id).toBe("store_xyz");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("createInstallationClient<AppPaths>.getStore() types the app's extra field", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Client-Key")).toBe("tok_app_owned");
      return jsonResponse(200, { data: { p_id: "store_xyz", name: "Test", loyalty_points: 7 } });
    });
    const client = createInstallationClient<AppStorePaths>({
      installationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      apiBase: API_BASE,
      tokens: {
        acquireToken: async () => "tok_app_owned",
        dropCachedToken: async () => undefined,
        revokeAppAccess: async () => undefined,
      },
      fetchImpl,
    });
    const store = await client.getStore();
    const points: number = store.data.loyalty_points;
    expect(points).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
