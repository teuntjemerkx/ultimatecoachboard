import "fake-indexeddb/auto";
import { all, get, makeBackup, put, remove, restoreBackup, clear } from "./db";

describe("storage on the device", () => {
  it("keeps players and matches, and a backup brings them back", async () => {
    await put("players", { id: "p1", number: 7, name: "Sanne", role: "OH" });
    await put("matches", { id: "m1", opponent: "Dynamo", events: [{ kind: "point", side: "home" }] });
    expect((await get<{ name: string }>("players", "p1"))?.name).toBe("Sanne");
    const backup = JSON.parse(JSON.stringify(await makeBackup()));
    await clear("players");
    await remove("matches", "m1");
    expect(await all("players")).toHaveLength(0);
    expect(await restoreBackup(backup)).toBe(2);
    expect((await get<{ events: unknown[] }>("matches", "m1"))?.events).toHaveLength(1);
  });
});
