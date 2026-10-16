// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CoachBoardCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CoachBoardCore", targets: ["CoachBoardCore"]),
    ],
    targets: [
        .target(
            name: "CoachBoardCore",
            resources: [.copy("Resources")]
        ),
        .testTarget(
            name: "CoachBoardCoreTests",
            dependencies: ["CoachBoardCore"]
        ),
    ]
)
