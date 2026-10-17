/** The coach's own notes on a match (their hitters, their serve): kept on the iPad, written at setup, shown in every time-out. */
export const matchNotes = {
  prefix: "coachboard.notes.",
  key: (matchId: string) => `${matchNotes.prefix}${matchId}`,
  read(matchId: string): string {
    try { return localStorage.getItem(matchNotes.key(matchId)) ?? ""; } catch { return ""; }
  },
  write(matchId: string, text: string) {
    try {
      if (text.trim()) localStorage.setItem(matchNotes.key(matchId), text);
      else localStorage.removeItem(matchNotes.key(matchId));
    } catch { /* private browsing: the notes last this visit */ }
  },
};
