// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SessionCaptureHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SessionCaptureHelper", targets: ["SessionCaptureHelper"])
    ],
    targets: [
        .executableTarget(
            name: "SessionCaptureHelper",
            dependencies: []
        )
    ]
)
