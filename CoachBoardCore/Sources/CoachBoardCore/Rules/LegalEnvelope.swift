import Foundation

/// The region in which a dragged player's centre keeps every applicable constraint legal
/// (blueprint Section 3.4.5). Every constraint is an axis-aligned half-plane in the
/// player's centre coordinates, so the region is a rectangle.
public struct LegalEnvelope: Hashable, Sendable {
    public var lMin: Double
    public var lMax: Double
    public var dMin: Double
    public var dMax: Double
    /// The neighbours whose constraints bound the region; when the region is empty these are
    /// the players to move first.
    public var boundingNeighbours: Set<CourtPosition>

    public var isEmpty: Bool { lMin >= lMax || dMin >= dMax }

    public func contains(_ p: LocalPoint) -> Bool {
        p.l > lMin && p.l < lMax && p.d > dMin && p.d < dMax
    }

    /// Computes the envelope for `player`, holding everyone else fixed.
    public static func compute(for player: CourtPosition,
                               positions: [CourtPosition: LocalPoint],
                               stances: [CourtPosition: Stance] = [:],
                               serving: Bool,
                               profile: RuleCourtProfile) -> LegalEnvelope {
        let options = OverlapEngine.Options(profile: profile)
        let width = profile.court.width
        let halfLength = profile.court.length / 2
        let ex = OverlapEngine.extremes(positions, stances: stances, options: options)
        guard let centre = positions[player], let own = ex[player] else {
            return LegalEnvelope(lMin: 0, lMax: 0, dMin: 0, dMax: 0, boundingNeighbours: [])
        }
        // Offsets from the centre to the player's own extreme foot points (fixed for the current stance).
        let eForward = centre.d - own.d
        let eLeft = centre.l - own.left
        let eRight = (width - centre.l) - own.right
        let eBack = own.maxD - centre.d

        var lo = (l: -Double.infinity, d: -Double.infinity)
        var hi = (l: Double.infinity, d: Double.infinity)
        var who = (lMin: Set<CourtPosition>(), lMax: Set<CourtPosition>(), dMin: Set<CourtPosition>(), dMax: Set<CourtPosition>())

        func tighten(_ bound: inout Double, to value: Double, isMax: Bool, neighbour: CourtPosition, set: inout Set<CourtPosition>) {
            if isMax ? value < bound : value > bound {
                bound = value
                set = [neighbour]
            } else if value == bound {
                set.insert(neighbour)
            }
        }

        let checked = serving ? profile.overlap.checkServingTeam : profile.overlap.checkReceivingTeam
        if checked {
            for (a, b, kind) in OverlapEngine.pairs {
                if serving && profile.overlap.serverExempt && (a == .p1 || b == .p1) { continue }
                guard a == player || b == player else { continue }
                let other = a == player ? b : a
                guard let eo = ex[other] else { continue }
                switch kind {
                case .frontBack:
                    if a == player {  // player must be nearer the centre line than `other`
                        tighten(&hi.d, to: eo.d + eForward, isMax: true, neighbour: other, set: &who.dMax)
                    } else {          // player must be deeper than `other`
                        tighten(&lo.d, to: eo.d + eForward, isMax: false, neighbour: other, set: &who.dMin)
                    }
                case .leftCentre:
                    if a == player {  // player is the left player
                        tighten(&hi.l, to: eo.left + eLeft, isMax: true, neighbour: other, set: &who.lMax)
                    } else {          // player is the centre player
                        tighten(&lo.l, to: eo.left + eLeft, isMax: false, neighbour: other, set: &who.lMin)
                    }
                case .rightCentre:
                    if a == player {  // player is the right player
                        tighten(&lo.l, to: width - eRight - eo.right, isMax: false, neighbour: other, set: &who.lMin)
                    } else {          // player is the centre player
                        tighten(&hi.l, to: width - eRight - eo.right, isMax: true, neighbour: other, set: &who.lMax)
                    }
                }
            }
        }

        if profile.overlap.requireInsideCourt && !(serving && profile.overlap.serverExempt && player == .p1) {
            lo.l = max(lo.l, eLeft)
            hi.l = min(hi.l, width - eRight)
            lo.d = max(lo.d, eForward)
            hi.d = min(hi.d, halfLength - eBack)
        }

        var env = LegalEnvelope(lMin: lo.l, lMax: hi.l, dMin: lo.d, dMax: hi.d, boundingNeighbours: [])
        if env.isEmpty {
            if env.lMin >= env.lMax { env.boundingNeighbours.formUnion(who.lMin.union(who.lMax)) }
            if env.dMin >= env.dMax { env.boundingNeighbours.formUnion(who.dMin.union(who.dMax)) }
        } else {
            env.boundingNeighbours = who.lMin.union(who.lMax).union(who.dMin).union(who.dMax)
        }
        return env
    }
}
