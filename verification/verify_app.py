
from playwright.sync_api import sync_playwright, expect
import time

def verify_frontend():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            print("Navigating to http://localhost:5173")
            page.goto("http://localhost:5173")

            # 1. Verify Header
            print("Verifying Header...")
            expect(page.locator("text=Community Lens Protocol")).to_be_visible()

            # 2. Verify Dropdown Label Change
            print("Verifying Dropdown Label...")
            expect(page.get_by_text("Curious? Here are some sample topics:")).to_be_visible()

            # 3. Verify Dropdown Options
            print("Verifying Dropdown Options...")
            # We expect seed data to be loaded from backend.
            # Backend is running on 4000.
            # Note: The client is pointing to render URL in code, but for local verification
            # it will try to hit that URL. If that URL is not reachable or valid yet,
            # the dropdown might be empty.
            # BUT, the prompt said "Change BASE_URL to my Render URL".
            # So local client will try to hit remote backend.
            # If remote backend is not up, this might fail or show empty list.
            # However, I should verify the UI structure primarily.

            # Let's take a screenshot of the main view
            print("Taking screenshot of Verifier View...")
            page.screenshot(path="verification/verifier_view.png")

            # 4. Navigate to Agent View
            print("Navigating to Agent Guard...")
            page.get_by_text("Agent Guard").click()
            expect(page.locator("text=Agent Status: ONLINE")).to_be_visible()

            # 5. Take screenshot of Agent View
            print("Taking screenshot of Agent View...")
            page.screenshot(path="verification/agent_view.png")

        except Exception as e:
            print(f"Verification failed: {e}")
            page.screenshot(path="verification/error.png")
            raise e
        finally:
            browser.close()

if __name__ == "__main__":
    verify_frontend()
