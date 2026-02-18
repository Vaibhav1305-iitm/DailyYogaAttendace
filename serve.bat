@echo off
title Yoga Attendance Server
echo.
echo  ========================================
echo    Yoga Attendance App - Local Server
echo  ========================================
echo.
echo  Starting server at http://localhost:3000
echo  Press Ctrl+C to stop
echo.
npx -y serve -l 3000 -s .
