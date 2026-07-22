// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "BandDeriver",
    platforms: [
        .iOS(.v16),
        .watchOS(.v9),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "BandDeriver",
            targets: ["BandDeriver"]
        )
    ],
    targets: [
        .target(
            name: "BandDeriver",
            dependencies: []
        ),
        .testTarget(
            name: "BandDeriverTests",
            dependencies: ["BandDeriver"]
        )
    ]
)
