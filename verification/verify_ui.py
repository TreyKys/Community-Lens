from playwright.sync_api import sync_playwright, expect
import time
import os

def run():
    # Ensure directory exists
    os.makedirs("verification", exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Wait for server to start
        print("Waiting for server...")
        for i in range(30):
            try:
                page.goto("http://localhost:5173", timeout=2000)
                break
            except:
                time.sleep(1)

        # 1. Verify Bounty Board & Modal
        page.wait_for_selector("text=Bounty Board")
        print("Bounty Board Loaded")

        # Open Create Modal
        page.click("text=Request Verification")
        page.wait_for_selector("text=Create New Bounty")
        print("Modal Opened")

        # Fill Form
        page.fill("textarea", "Test Claim")

        page.screenshot(path="verification/step1_modal.png")
        print("Screenshot 1 taken")

        # Reload to reset state (Close modal)
        page.reload()
        page.wait_for_selector("text=Bounty Board")

        # 2. Verify Verification Terminal
        page.click("text=Verification Terminal")
        page.wait_for_selector("text=Grokipedia Source")
        print("Verifier Loaded")

        page.screenshot(path="verification/step2_verifier.png")
        print("Screenshot 2 taken")

        # 3. Verify Agent Guard
        page.click("text=Agent Guard")
        page.wait_for_selector("text=Ask me anything")
        print("Agent Guard Loaded")

        # Send a message
        page.fill("input[type=text]", "Hello")
        page.click("button[type=submit]")
        page.wait_for_selector("text=Hello")

        page.screenshot(path="verification/step3_agent.png")
        print("Screenshot 3 taken")

        browser.close()

if __name__ == "__main__":
    run()
