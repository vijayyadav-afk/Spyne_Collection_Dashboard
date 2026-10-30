#!/bin/sh
# Cloudflare Pages build: publish only the pages (not the api/ source) from public/
rm -rf public && mkdir public && cp ./*.html _headers _redirects public/
