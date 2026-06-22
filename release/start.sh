#!/usr/bin/env bash

echo ""
echo "============================================"
echo "         zcode-proxy Manager"
echo "============================================"
echo ""
echo "  1. Start proxy server"
echo "  2. OAuth login (Bigmodel) - Coding Plan"
echo "  3. OAuth login (Z.AI) - Coding Plan"
echo "  4. OAuth login (Bigmodel) - Start Plan"
echo "  5. OAuth login (Z.AI) - Start Plan"
echo "  6. Import key from ZCode (Bigmodel)"
echo "  7. Import key from ZCode (Z.AI)"
echo "  8. Check login status"
echo "  9. Logout"
echo "  0. Exit"
echo ""
read -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    chmod +x zcode-proxy.exe
    ./zcode-proxy.exe serve --config config.yaml
    ;;
  2)
    echo ""
    echo "Starting Bigmodel OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=coding-plan
    ;;
  3)
    echo ""
    echo "Starting Z.AI OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=coding-plan
    ;;
  4)
    echo ""
    echo "Starting Bigmodel OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=start-plan
    ;;
  5)
    echo ""
    echo "Starting Z.AI OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=start-plan
    ;;
  6)
    echo ""
    echo "Importing key from ZCode (Bigmodel)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import
    ;;
  7)
    echo ""
    echo "Importing key from ZCode (Z.AI)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import
    ;;
  8)
    echo ""
    ./zcode-proxy.exe auth status
    ;;
  9)
    echo ""
    ./zcode-proxy.exe auth logout
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
