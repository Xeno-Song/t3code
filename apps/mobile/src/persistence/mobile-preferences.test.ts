import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

const makeStorage = (initial: string | null = null) => {
  let stored: MobileDatabase.StoredPreferencesJson | null =
    initial === null ? null : { payload: initial, updatedAt: 1 };
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeedNone,
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.fromNullishOr(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return MobilePreferences.make().pipe(
    Effect.provideService(MobileDatabase.MobileDatabase, database),
    Effect.provideService(MobileSecureStorage.MobileSecureStorage, secureStorage),
  );
};

describe("response reception mobile preference", () => {
  it.effect("leaves old preferences off and persists both toggle directions", () =>
    Effect.gen(function* () {
      const store = yield* makeStorage('{"baseFontSize":17}');
      expect((yield* store.load).responseReceptionIndicatorEnabled ?? false).toBe(false);
      yield* store.savePatch({ responseReceptionIndicatorEnabled: true });
      expect(yield* store.load).toMatchObject({
        baseFontSize: 17,
        responseReceptionIndicatorEnabled: true,
      });
      yield* store.savePatch({ responseReceptionIndicatorEnabled: false });
      expect(yield* store.load).toMatchObject({
        baseFontSize: 17,
        responseReceptionIndicatorEnabled: false,
      });
    }),
  );
  it.effect("ignores a malformed saved indicator preference", () =>
    Effect.gen(function* () {
      const store = yield* makeStorage('{"responseReceptionIndicatorEnabled":"true"}');
      expect((yield* store.load).responseReceptionIndicatorEnabled).toBeUndefined();
    }),
  );
});
