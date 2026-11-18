#include <gtk/gtk.h>
#include <string.h>
#include <vte/vte.h>

static gboolean check_screen(gpointer data)
{
    VteTerminal *terminal = VTE_TERMINAL(data);
    g_autofree char *screen = vte_terminal_get_text(terminal, NULL, NULL, NULL);
    gboolean ok = screen && strstr(screen, "prompt> input") &&
                  !strstr(screen, "7501;") && !strstr(screen, "21337;");
    if (!ok)
        g_printerr("Terminal status sequences leaked into the visible prompt: %s\n", screen);
    g_object_set_data(G_OBJECT(terminal), "verified", GINT_TO_POINTER(ok));
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

int main(int argc, char **argv)
{
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    GtkWidget *terminal = vte_terminal_new();
    gtk_container_add(GTK_CONTAINER(window), terminal);
    gtk_window_set_default_size(GTK_WINDOW(window), 640, 360);
    gtk_widget_show_all(window);

    const char output[] = "prompt> "
                          "\033]7501;state=idle:app=codex\033\\"
                          "\033]21337;status=ready\007"
                          "input";
    vte_terminal_feed(VTE_TERMINAL(terminal), output, sizeof(output) - 1);
    g_timeout_add(250, check_screen, terminal);
    gtk_main();
    if (!g_object_get_data(G_OBJECT(terminal), "verified"))
        return 1;

    g_print("VTE %u.%u.%u ignored OSC 7501 and OSC 21337 without changing the prompt.\n",
            vte_get_major_version(), vte_get_minor_version(), vte_get_micro_version());
    return 0;
}
