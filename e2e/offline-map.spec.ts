import { readFileSync } from 'node:fs'
import { test, expect, newPerson, createCircle, addZoneOnMap } from './fixtures'

// A real (tiny, low-zoom) PMTiles archive, cut from the Harrogate extract with
// go-pmtiles — the mock must return VALID bytes because the flow parses the
// archive header (OPFS → FileSource → maplibre style). CI has no go-pmtiles and
// must never hit the live extract service, hence the route mock.
const TINY_PMTILES = readFileSync(new URL('./fixtures/tiny-area.pmtiles', import.meta.url))

type MapSeam = { flockMapView?: { map: { jumpTo(o: { center: [number, number]; zoom: number }): void; getCenter(): { lng: number; lat: number }; getZoom(): number } } }

test.describe('offline map — save this area (extract mocked)', () => {
  test('save → OPFS → offline render; the label toggle keeps the camera', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    await A.route('**/api/extract', (route) =>
      route.fulfill({ status: 200, contentType: 'application/octet-stream', body: TINY_PMTILES }),
    )

    // A safe place gives the save an area to bound; the control is on by default.
    await addZoneOnMap(A, 'safe')
    await A.click('[data-action="save-offline-map"]')
    await expect(A.locator('#map-panel')).toContainText(/Saved · .+ · works offline/, { timeout: 20_000 })

    // The offline style is live: the label toggle only exists once an area is saved.
    await expect(A.locator('[data-action="map-labels"][data-mode="local"]')).toBeVisible()

    // Move away, then switch label language — the style re-init must NOT yank the view.
    await A.evaluate(() => (window as unknown as MapSeam).flockMapView!.map.jumpTo({ center: [-1.54, 53.995], zoom: 11 }))
    await A.click('[data-action="map-labels"][data-mode="local"]')
    await expect(A.locator('[data-action="map-labels"][data-mode="local"]')).toHaveAttribute('aria-pressed', 'true')
    await A.waitForFunction(() => {
      const m = (window as unknown as MapSeam).flockMapView?.map
      return !!m && Math.abs(m.getZoom() - 11) < 0.2 && Math.abs(m.getCenter().lng - -1.54) < 0.01
    }, undefined, { timeout: 15_000 })
  })
})
