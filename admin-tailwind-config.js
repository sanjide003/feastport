if (window.tailwind) {
  window.tailwind.config = {
    ...(window.tailwind.config || {}),
    darkMode: 'class'
  };
}
