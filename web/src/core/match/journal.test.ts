// Port of JournalTests (GeometryJournalLiveTests.swift). File IO is in memory: the writer's `data` is the file.
import { describe, expect, it } from "vitest";
import { DecodingError } from "./codable";
import {
  CRC32C, JournalCodec, JournalError, JournalHeader, JournalPayload, JournalRecord, JournalRecordType, JournalWriter,
  MatchStartedPayload, RallyWonPayload,
} from "./journal";
import { TeamSheet, newPlayerID } from "./matchState";

describe("JournalTests", () => {
  it("CRC-32C known answer", () => {
    // RFC 3720 check value for the ASCII digits 1...9.
    expect(CRC32C.checksum(new TextEncoder().encode("123456789"))).toBe(0xE3069283);
  });

  it("round trip and torn tail recovery", () => {
    const header = JournalHeader.make(newPlayerID(), 1_700_000_000_000_000_000, new Uint8Array(32).fill(7));
    const writer = new JournalWriter(header);
    for (let i = 0; i < 5; i++) {
      writer.append(JournalRecordType.rallyWon,
                    JournalPayload.encode(RallyWonPayload, { winner: i % 2 === 0 ? "home" : "opponent" }), i);
    }
    writer.commit();

    const data = writer.data;
    const ok = JournalCodec.read(data);
    expect(ok.records.length).toBe(5);
    expect(ok.hadTornTail).toBe(false);
    expect(ok.header.matchID).toBe(header.matchID);
    expect(ok.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(JournalPayload.decode(RallyWonPayload, ok.records[1].payload).winner).toBe("opponent");

    // Simulate power loss in the middle of the last record.
    const tornData = data.slice(0, data.length - 7);
    const torn = JournalCodec.read(tornData);
    expect(torn.records.length).toBe(4);
    expect(torn.hadTornTail).toBe(true);

    // Reopening truncates the torn tail and continues the sequence.
    const reopened = new JournalWriter(header, tornData);
    expect(reopened.nextSeq).toBe(5);
    reopened.append(JournalRecordType.note, new Uint8Array(), 9);
    reopened.commit();
    const after = JournalCodec.read(reopened.data);
    expect(after.records.length).toBe(5);
    expect(after.hadTornTail).toBe(false);
  });

  it("corrupted record stops the read", () => {
    const writer = new JournalWriter(JournalHeader.make(newPlayerID(), 0, new Uint8Array(32)));
    writer.append(JournalRecordType.note, Uint8Array.of(1, 2, 3), 0);
    writer.append(JournalRecordType.note, Uint8Array.of(4, 5, 6), 0);
    writer.commit();
    const data = writer.data.slice();
    data[data.length - 6] ^= 0xFF;      // flip a payload byte of the second record
    const result = JournalCodec.read(data);
    expect(result.records.length).toBe(1);
    expect(result.hadTornTail).toBe(true);
  });

  it("header, record layout, resuming and payload errors (web)", () => {
    const matchID = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
    const header = JournalHeader.make(matchID, -5, new Uint8Array(32).fill(3));
    const bytes = JournalHeader.encoded(header);
    expect(bytes.length).toBe(64);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x43, 0x42, 0x4A, 0x31, 1, 0, 0, 0]);
    expect(Array.from(bytes.subarray(8, 12))).toEqual([0xE6, 0x21, 0xE1, 0xF8]);
    expect(JournalHeader.decode(bytes)).toEqual(header);
    expect(() => JournalHeader.decode(bytes.subarray(0, 63))).toThrow(JournalError);

    const record = JournalRecord.make({ type: JournalRecordType.note, seq: 2 ** 40 + 3, lamport: 7, wallClock: -1234,
                                        payload: Uint8Array.of(9, 8) });
    const encoded = JournalRecord.encoded(record);
    expect(encoded.length).toBe(4 + 28 + 2 + 4);
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(30);
    const read = JournalCodec.read(new Uint8Array([...bytes, ...encoded]));
    expect(read.records).toEqual([record]);

    const writer = new JournalWriter(header);
    writer.append(JournalRecordType.rallyWon, JournalPayload.encode(RallyWonPayload, { winner: "home" }), 1);
    const committed = writer.commit();
    expect(committed.map((r) => r.seq)).toEqual([1]);
    expect(writer.commit()).toEqual([]);
    const resumed = JournalWriter.resuming(header, committed);
    expect(resumed.nextSeq).toBe(2);
    expect(resumed.lamport).toBe(1);
    expect(resumed.data).toEqual(writer.data);

    expect(() => JournalPayload.decode(RallyWonPayload, new Uint8Array())).toThrow(DecodingError);
    expect(() => JournalPayload.decode(RallyWonPayload, JournalPayload.encode(RallyWonPayload, { winner: "home" }).subarray(1)))
      .toThrow(DecodingError);

    // MatchStarted: TeamSheet roles and the jersey/name dictionaries use Swift's flat [key, value, ...] arrays.
    const a = newPlayerID();
    const ids = [a, newPlayerID(), newPlayerID(), newPlayerID(), newPlayerID(), newPlayerID()];
    const sheet = TeamSheet.make({ startingLineup: ids, roles: { [a]: "S" }, liberoPartners: [ids[2]] });
    const setup: MatchStartedPayload = { profileName: "FIVB senior indoor", home: sheet, opponent: sheet, firstServer: "home",
                                         mode: "solo", templateID: "4-2", jerseys: { [a]: 7 }, names: { [a]: "Ann" } };
    const json = MatchStartedPayload.encode(setup) as Record<string, unknown>;
    expect((json.home as Record<string, unknown>).roles).toEqual([a, "S"]);
    expect((json.home as Record<string, unknown>).liberoPartners).toEqual([ids[2]]);
    expect(json.jerseys).toEqual([a, 7]);
    expect("homeName" in json).toBe(false);
    expect(JournalPayload.decode(MatchStartedPayload, JournalPayload.encode(MatchStartedPayload, setup))).toEqual(setup);
  });
});
