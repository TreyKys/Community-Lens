from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(record_video_dir="/home/jules/verification/video")
    page = context.new_page()

    # 1. Verify Home & Markets
    print("Navigating to home...")
    page.goto("http://localhost:3000/", timeout=120000)
    page.wait_for_timeout(2000)

    print("Navigating to markets...")
    page.goto("http://localhost:3000/markets", timeout=120000)
    page.wait_for_timeout(3000)

    # Screenshot the market list
    page.screenshot(path="/home/jules/verification/markets_updated.png")
    page.wait_for_timeout(1000)

    # Expand the first market card
    first_market = page.locator(".hover\\:shadow-lg").first
    if first_market.is_visible():
        print("Clicking first market card to expand...")
        first_market.locator("text=View Options").click()
        page.wait_for_timeout(1000)
        page.screenshot(path="/home/jules/verification/market_expanded.png")

    # 2. Verify Admin Panel & Presets Grid
    print("Navigating to admin...")
    page.goto("http://localhost:3000/admin", timeout=120000)
    page.wait_for_timeout(5000)

    # Screenshot the Admin panel with Preset Grid
    page.screenshot(path="/home/jules/verification/admin_presets.png")
    page.wait_for_timeout(1000)

    # Fill in a question to test presets
    page.fill("input[placeholder='Arsenal vs Chelsea']", "Real Madrid vs Barcelona")
    page.wait_for_timeout(500)

    # Check the "Match Winner" preset
    page.locator("label[for='preset-match-winner']").click()
    page.wait_for_timeout(500)

    # Check the "BTTS" preset
    page.locator("label[for='preset-btts']").click()
    page.wait_for_timeout(500)

    # Set a deadline
    page.fill("input[type='datetime-local']", "2025-12-31T23:59")
    page.wait_for_timeout(500)

    page.screenshot(path="/home/jules/verification/admin_presets_filled.png")
    page.wait_for_timeout(1000)

    # Scroll down to capture the Admin Master Table
    page.evaluate("window.scrollBy(0, 1000)")
    page.wait_for_timeout(1000)
    page.screenshot(path="/home/jules/verification/admin_master_table.png")
    page.wait_for_timeout(1000)

    context.close()
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
