import XCTest
@testable import Kairos

/// AuthService protocol conformance tests using the fake implementation,
/// per the task brief: "sign in -> currentUser populated, sign out -> nil."
@MainActor
final class FakeAuthServiceTests: XCTestCase {

    func test_initialState_currentUserIsNil() {
        let sut = FakeAuthService()
        XCTAssertNil(sut.currentUser)
    }

    func test_signInWithApple_populatesCurrentUser() async throws {
        let sut = FakeAuthService()
        let user = try await sut.signInWithApple()

        XCTAssertEqual(sut.currentUser, user)
        XCTAssertNotNil(sut.currentUser)
        XCTAssertFalse(user.isPrivateRelayEmail)
    }

    func test_signInWithApple_relaySimulation_marksPrivateRelay() async throws {
        let sut = FakeAuthService(simulatesPrivateRelayEmail: true)
        let user = try await sut.signInWithApple()

        XCTAssertTrue(user.isPrivateRelayEmail)
        XCTAssertTrue(user.email?.hasSuffix("@privaterelay.appleid.com") ?? false)
    }

    func test_signInWithEmail_populatesCurrentUser() async throws {
        let sut = FakeAuthService()
        let user = try await sut.signInWithEmail(email: "test@example.com", password: "hunter22")

        XCTAssertEqual(sut.currentUser, user)
        XCTAssertEqual(user.email, "test@example.com")
    }

    func test_signInWithEmail_shortPassword_throwsInvalidCredential() async {
        let sut = FakeAuthService()
        do {
            _ = try await sut.signInWithEmail(email: "test@example.com", password: "abc")
            XCTFail("Expected AuthError.invalidCredential")
        } catch let error as AuthError {
            XCTAssertEqual(error, .invalidCredential)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
        XCTAssertNil(sut.currentUser)
    }

    func test_signOut_clearsCurrentUser() async throws {
        let sut = FakeAuthService()
        _ = try await sut.signInWithApple()
        XCTAssertNotNil(sut.currentUser)

        try sut.signOut()

        XCTAssertNil(sut.currentUser)
    }

    func test_injectedError_isThrownAndClearsAfterOneUse() async {
        let sut = FakeAuthService()
        sut.nextSignInError = .network("offline")

        do {
            _ = try await sut.signInWithApple()
            XCTFail("Expected AuthError.network")
        } catch let error as AuthError {
            XCTAssertEqual(error, .network("offline"))
        } catch {
            XCTFail("Wrong error type: \(error)")
        }

        // Error is consumed; next call should succeed.
        let user = try? await sut.signInWithApple()
        XCTAssertNotNil(user)
    }

    func test_setInviteEmail_updatesUserAndVerifies() async throws {
        let sut = FakeAuthService()
        _ = try await sut.signInWithApple()

        let updated = try await sut.setInviteEmail("invites@example.com")

        XCTAssertEqual(updated.inviteEmail, "invites@example.com")
        XCTAssertTrue(updated.isInviteEmailVerified)
        XCTAssertEqual(sut.currentUser?.inviteEmail, "invites@example.com")
    }

    func test_setInviteEmail_withoutSignIn_throws() async {
        let sut = FakeAuthService()
        do {
            _ = try await sut.setInviteEmail("invites@example.com")
            XCTFail("Expected an error when no user is signed in")
        } catch {
            // any AuthError is acceptable here
        }
    }

    func test_setInviteEmail_invalidFormat_throwsInvalidCredential() async throws {
        let sut = FakeAuthService()
        _ = try await sut.signInWithApple()

        do {
            _ = try await sut.setInviteEmail("not-an-email")
            XCTFail("Expected AuthError.invalidCredential")
        } catch let error as AuthError {
            XCTAssertEqual(error, .invalidCredential)
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }

    func test_isPrivateRelay_detection() {
        XCTAssertTrue(KairosUser.isPrivateRelay("abc123@privaterelay.appleid.com"))
        XCTAssertFalse(KairosUser.isPrivateRelay("person@gmail.com"))
        XCTAssertFalse(KairosUser.isPrivateRelay(nil))
    }
}
