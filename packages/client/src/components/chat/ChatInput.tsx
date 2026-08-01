import { FaArrowUp } from 'react-icons/fa';
import { NotebookPen } from 'lucide-react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useForm } from 'react-hook-form';
import { cn } from '@/lib/utils';

export type ChatFormData = {
   prompt: string;
};

type Props = {
   onSubmit: (data: ChatFormData) => void;
   disabled?: boolean;
   takeNotes: boolean;
   onTakeNotesChange: (value: boolean) => void;
   showTakeNotes: boolean;
};

export const ChatInput = ({
   onSubmit,
   disabled = false,
   takeNotes,
   onTakeNotesChange,
   showTakeNotes,
}: Props) => {
   const { register, handleSubmit, reset, formState } = useForm<ChatFormData>();

   const submit = handleSubmit((data) => {
      reset({ prompt: '' });
      onSubmit(data);
   });

   const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         if (!disabled) submit();
      }
   };
   return (
      <form
         onSubmit={submit}
         onKeyDown={handleKeyDown}
         className="flex flex-col gap-2 border border-border bg-card p-4 rounded-3xl w-full max-w-4xl"
      >
         <Textarea
            autoFocus
            {...register('prompt', {
               required: true,
               validate: (data) => data.trim().length > 0,
            })}
            disabled={disabled}
            className="w-full border-0 shadow-none focus-visible:ring-0 resize-none"
            placeholder="Ask anything..."
            maxLength={500}
         />
         <div className="flex w-full items-center justify-between">
            {showTakeNotes ? (
               <button
                  type="button"
                  role="switch"
                  aria-checked={takeNotes}
                  onClick={() => onTakeNotesChange(!takeNotes)}
                  className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-muted"
               >
                  <NotebookPen className="size-4" />
                  Take notes
                  <span
                     className={cn(
                        'flex h-4 w-7 items-center rounded-full p-0.5',
                        takeNotes ? 'bg-teal-500' : 'bg-gray-400',
                     )}
                  >
                     <span
                        className={cn(
                           'size-3 rounded-full bg-background transition-transform',
                           takeNotes && 'translate-x-3',
                        )}
                     />
                  </span>
               </button>
            ) : (
               <span />
            )}
            <Button
               disabled={!formState.isValid || disabled}
               type="submit"
               className="rounded-full w-9 h-9"
            >
               <FaArrowUp />
            </Button>
         </div>
      </form>
   );
};

