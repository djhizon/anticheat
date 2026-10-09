import Foundation

/// Generation fencing prevents an old response from restarting a loop after Home/lock.
struct ForegroundGate {
    private(set) var active = false
    private(set) var generation = 0
    mutating func transition(active: Bool) {
        self.active = active
        generation += 1
    }
    func permits(_ generation: Int) -> Bool { active && self.generation == generation }
}

struct PairingLink {
    let origin: URL
    let code: String
    var isHTTP: Bool { origin.scheme == "http" }

    init(_ text: String, allowHTTP: Bool) throws {
        guard let link = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              link.scheme == "examcompanion", link.host == "pair", link.path.isEmpty,
              link.user == nil, link.password == nil, link.port == nil, link.fragment == nil,
              let items = link.queryItems, items.count == 2,
              items.filter({ $0.name == "origin" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              let originText = items.first(where: { $0.name == "origin" })?.value,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let origin = URLComponents(string: originText), let host = origin.host,
              origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              origin.path.isEmpty || origin.path == "/",
              origin.scheme == "https" || (allowHTTP && origin.scheme == "http" && Self.privateIPv4(host)),
              host != "localhost", !host.hasSuffix(".localhost"), !host.hasPrefix("127."),
              host != "::1", host != "[::1]", host != "0.0.0.0",
              let url = origin.url else { throw PairingError.invalidLink }
        self.origin = url
        self.code = code
    }
    private static func privateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return false }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == 4, numbers.allSatisfy({ (0...255).contains($0) }) else { return false }
        return numbers[0] == 10 || (numbers[0] == 192 && numbers[1] == 168) ||
            (numbers[0] == 172 && (16...31).contains(numbers[1]))
    }
}

enum PairingError: Error { case invalidLink, rejected, network }
