from playwright.sync_api import sync_playwright
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # 1. Landing Page
        print("Visiting Landing Page...")
        try:
            page.goto("http://localhost:3000")
            page.wait_for_selector("h1:text('TruthMarket')", timeout=30000)
            page.screenshot(path="verification_landing.png")
            print("Landing Page screenshot saved.")
        except Exception as e:
            print(f"Error visiting landing page: {e}")

        # 2. Markets Page
        print("Visiting Markets Page...")
        try:
            page.goto("http://localhost:3000/markets")
            page.wait_for_selector("h1:text('Active Markets')", timeout=30000)
            page.screenshot(path="verification_markets.png")
            print("Markets Page screenshot saved.")
        except Exception as e:
            print(f"Error visiting markets page: {e}")

        # 3. Filter Sports
        print("Filtering Sports...")
        try:
            # Click "Sports" button in sidebar
            # Sidebar button text is "Sports"
            page.get_by_role("button", name="Sports").click()
            time.sleep(2) # Wait for URL update and re-render
            page.screenshot(path="verification_sports.png")
            print("Sports Filter screenshot saved.")
        except Exception as e:
            print(f"Error filtering sports: {e}")

        # 4. Admin Page
        print("Visiting Admin Page...")
        try:
            page.goto("http://localhost:3000/admin")
            page.wait_for_selector("h1:text('Admin Dashboard')", timeout=30000)
            page.screenshot(path="verification_admin.png")
            print("Admin Page screenshot saved.")
        except Exception as e:
            print(f"Error visiting admin page: {e}")

        browser.close()

if __name__ == "__main__":
    run()
