from playwright.sync_api import sync_playwright, expect
import os
import glob

def verify(page):
    page.on("console", lambda msg: print(f"Browser console: {msg.text}"))
    page.on("pageerror", lambda msg: print(f"Browser error: {msg}"))

    # Desktop tests
    page.goto("http://localhost:3000/")
    page.wait_for_timeout(2000)

    # Click Sign In / Sign Up to open Privy
    page.get_by_role("button", name="Sign In / Sign Up").click()
    page.wait_for_timeout(2000)

    # Close Privy modal for now by clicking outside or pressing escape
    page.keyboard.press("Escape")
    page.wait_for_timeout(1000)

    # Navigate to Markets
    page.goto("http://localhost:3000/markets")
    page.wait_for_timeout(2000)

    # Check Sidebar Mobile Hamburger
    page.set_viewport_size({"width": 375, "height": 812})
    page.wait_for_timeout(1000)

    # Open mobile menu
    menu_button = page.locator('button:has(.lucide-menu)')
    if menu_button.is_visible():
        menu_button.click()
        page.wait_for_timeout(1500)

    page.screenshot(path="/home/jules/verification/mobile_sidebar.png")

    # Navigate back to Desktop
    page.set_viewport_size({"width": 1280, "height": 800})
    page.wait_for_timeout(1000)

    # Go to an Event Page
    page.goto("http://localhost:3000/event/1")
    page.wait_for_timeout(8000) # Give it 8 seconds to load completely

    page.screenshot(path="/home/jules/verification/event_page.png")
    page.wait_for_timeout(1000)

    # Check Area Chart & Momentum Bar
    expect(page.get_by_text("Momentum Volume")).to_be_visible()

if __name__ == "__main__":
    os.makedirs("/home/jules/verification/video", exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(record_video_dir="/home/jules/verification/video")
        page = context.new_page()
        try:
            verify(page)
        except Exception as e:
            print(f"Error: {e}")
        finally:
            context.close()
            browser.close()

        videos = glob.glob("/home/jules/verification/video/*.webm")
        if videos:
            print(f"Video saved to: {videos[0]}")
