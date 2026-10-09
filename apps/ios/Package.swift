// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PresenceCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "PresenceCore", targets: ["PresenceCore"])],
    targets: [
        .target(name: "PresenceCore", path: "Sources/Core"),
        .testTarget(name: "PresenceCoreTests", dependencies: ["PresenceCore"], path: "Tests")
    ]
)
