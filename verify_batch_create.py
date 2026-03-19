from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    # Verify Admin Panel & Presets Grid
    print("Navigating to admin...")
    page.goto("http://localhost:3000/admin")
    page.wait_for_timeout(3000)

    # Fill in a question to test presets
    page.fill("input[placeholder='Arsenal vs Chelsea']", "Batch Test Event")
    page.wait_for_timeout(500)

    # Check the "Match Winner" preset
    page.locator("label[for='preset-match-winner']").click()
    page.wait_for_timeout(500)

    # Set a deadline
    page.fill("input[type='datetime-local']", "2025-12-31T23:59")
    page.wait_for_timeout(500)

    # Click Create Market
    page.get_by_role("button", name="Create Market").click()
    page.wait_for_timeout(2000)

    # Check for toast error message (Wagmi error)
    if page.locator("text=Function createMarketBatch not found on ABI").is_visible():
        print("Wagmi Error detected!")
        page.screenshot(path="/home/jules/verification/wagmi_error.png")
    else:
        print("No Wagmi Error detected. Waiting to see if the transaction prompt appears...")
        page.screenshot(path="/home/jules/verification/no_wagmi_error.png")

    context.close()
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
